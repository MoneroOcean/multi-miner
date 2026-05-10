#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MultiMinerApp } = require("../mm");
const { assertNoLiveFailures, captureOutput, envInt, freePort, printSimpleResult, quoteForCommand, selectedCases, shellQuote, tail, waitForLiveSubmit, withTimeout, words, writeLiveConfig } = require("./common/live-helpers");
const { createLiveFakePool } = require("./common/live-fake-pool");
const { ensureMinerBinary } = require("./common/live-miner-downloads");
const { findConfiguredMinerBinary } = require("./common/live-miner-cache");

const LIVE_TIMEOUT_MS = envInt("MM_LIVE_TIMEOUT_MS", 90000);
const CPU_CASES = [
  ["xmrig-rx-0", "rx/0"],
  ["xmrig-rx-graft", "rx/graft"],
  ["xmrig-rx-arq", "rx/arq"],
  ["xmrig-cn-r", "cn/r"],
  ["xmrig-cn-heavy-xhv", "cn-heavy/xhv"],
  ["xmrig-cn-pico-trtl", "cn-pico/trtl"],
  ["xmrig-ghostrider", "ghostrider"],
  ["xmrig-panthera", "panthera"],
].map(([name, algo]) => ({ algo, name }));

main().catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});

async function main() {
  const binary = await findXmrig();
  const results = [];

  for (const testCase of selectedCases(CPU_CASES, "MM_LIVE_CPU_CASES")) {
    const result = binary
      ? await runCase(binary, testCase)
      : { name: testCase.name, status: "skipped", reason: "xmrig binary not found" };
    results.push(result);
    printSimpleResult("live-cpu-miners", result);
  }

  assertNoLiveFailures(assert, results);
}

async function runCase(binary, testCase) {
  const minerPort = await freePort();
  const pool = await createLiveFakePool(testCase);
  const output = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-cpu-live-"));
  const app = new MultiMinerApp(appArgs(binary, testCase, minerPort, pool.port, tmpDir), {
    cwd: tmpDir,
    reconnectDelayMs: 1000,
    skipMinerCheck: true,
    watchdogIntervalMs: 1000,
  });
  captureOutput(app, output);

  try {
    await withTimeout(app.run(), 15000, testCase.name + " Multi-Miner did not start");
    const login = await withTimeout(pool.login, 15000, testCase.name + " Multi-Miner did not log in to fake pool");
    assert.equal(login.method, "login");
    assert.ok(login.params.algo.includes(testCase.algo));
    await waitForLiveSubmit(pool, testCase.name, output, LIVE_TIMEOUT_MS);
    return { name: testCase.name, status: "passed", outcome: "submit" };
  } catch (error) {
    return { name: testCase.name, status: "failed", reason: error.message, output: tail(output.join("\n")) };
  } finally {
    await app.stop();
    await pool.close();
  }
}

function appArgs(binary, testCase, minerPort, poolPort, tmpDir) {
  const configPath = path.join(tmpDir, "mm.json");
  writeLiveConfig(configPath, minerPort, poolPort, testCase.algo, xmrigCommand(binary, testCase, minerPort, tmpDir));
  const args = [configPath, "--no-config-save"];
  if (process.env.MM_LIVE_DEBUG) args.push("--verbose", "--debug");
  return args;
}

async function findXmrig() {
  return findConfiguredMinerBinary("XMRIG_PATH", "xmrig-mo", process.platform === "win32" ? "xmrig.exe" : "xmrig") || await ensureMinerBinary("xmrig-mo");
}

function xmrigCommand(binary, testCase, minerPort, tmpDir) {
  const configPath = path.join(tmpDir, "xmrig-config.json");
  fs.writeFileSync(configPath, JSON.stringify(xmrigSeedConfig(testCase.algo), null, 2));
  const dir = path.dirname(binary);
  const exe = "./" + path.basename(binary);
  const inner = [
    "cd " + shellQuote(dir),
    "&&",
    shellQuote(exe),
    "-c " + shellQuote(configPath),
    "-o 127.0.0.1:" + minerPort,
    "-u wallet",
    "-p x",
    "--rig-id mm-live",
    "-t 1",
    "--cpu-priority 0",
    "--donate-level 0",
    "--bench-algo-time 0",
    "--print-time 1",
    "--keepalive",
    "--no-color",
  ].join(" ");
  return "/bin/sh -lc " + quoteForCommand(inner);
}

function xmrigSeedConfig(algo) {
  const perf = Object.fromEntries(words("argon2/chukwav2 cn-heavy/xhv cn/half cn/gpu cn-lite/1 cn-pico cn-pico/trtl cn/r cn/ccx flex ghostrider kawpow panthera rx/0 rx/arq rx/graft rx/wow")
    .map((algorithm) => [algorithm, 1]));
  return { autosave: false, "algo-min-time": 0, "bench-algo-time": 0, "rebench-algo": false, "algo-perf": { ...perf, [algo]: 1 } };
}
