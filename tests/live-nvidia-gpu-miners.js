#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MultiMinerApp } = require("../mm");
const { extractHashrates } = require("../src/hashrate");
const { assertNoLiveFailures, captureOutput, delay, envInt, freePort, quoteForCommand, safeFailureClass, safeResultSummary, selectedCases, shellQuote, withTimeout, writeLiveConfig } = require("./common/live-helpers");
const { assertEasyEthTargets, createLiveFakePool } = require("./common/live-fake-pool");
const { ensureMinerBinaries } = require("./common/live-miner-downloads");
const { findMinerBinary, findMinerCommandDir } = require("./common/live-miner-cache");
const { nvidiaMinerPlans } = require("./fixtures/nvidia-miner-plans");

const WALLET = "wallet";
const LIVE_TIMEOUT_MS = envInt("MM_LIVE_TIMEOUT_MS", 70000);
const KAWPOW_LIVE_TIMEOUT_MS = envInt("MM_LIVE_KAWPOW_TIMEOUT_MS", 180000);
const C29_LIVE_TIMEOUT_MS = envInt("MM_LIVE_C29_TIMEOUT_MS", 600000);
const CAPTURE_DIR = process.env.MM_LIVE_CAPTURE_DIR || "";
const WAIT_HASHRATE = process.env.MM_LIVE_WAIT_HASHRATE === "1";
let resolvedMinerPaths = {};

const MINERS = nvidiaMinerPlans((minerDir, command) => scriptCommand(minerDir, command, resolvedMinerPaths), WALLET);
assertEasyEthTargets(MINERS);

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`live-nvidia-gpu-miners: status=failed failure=${safeFailureClass(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const miners = selectedCases(MINERS, "MM_LIVE_NVIDIA_GPU_MINERS");
  if (!hasNvidiaGpu()) {
    for (const miner of miners) printResult({ name: miner.name, status: "skipped", reason: "NVIDIA GPU not found" });
    return;
  }
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-nvidia-extraction-"));
  let stopped = true;
  try {
    resolvedMinerPaths = await ensureMinerBinaries(miners.flatMap((miner) => [miner.binary, miner.cudaBinary].filter(Boolean).map((value) => value.split("/", 1)[0])), {extractionRoot});
    const results = [];
    for (const miner of miners) {
      stopped = false;
      const result = await runMiner(miner);
      stopped = true;
      results.push(result);
      printResult(result);
    }
    assertNoLiveFailures(assert, results);
  } finally {
    if (stopped) fs.rmSync(extractionRoot, {recursive: true, force: true});
  }
}

async function runMiner(miner) {
  const minerPort = await freePort();
  const pool = await createLiveFakePool(miner);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-live-nvidia-gpu-"));
  const configPath = path.join(tmpDir, "mm.json");
  const output = [];
  const minerCommand = miner.command(minerPort, minerCommandContext(miner, tmpDir));
  if (!minerCommand) {
    await pool.close();
    return { name: miner.name, status: "skipped", reason: "binary not found" };
  }
  writeLiveConfig(configPath, minerPort, pool.port, miner.algo, minerCommand);
  const appArgs = [configPath, "--no-config-save"];
  if (process.env.MM_LIVE_DEBUG) appArgs.push("--debug");
  const app = new MultiMinerApp(appArgs, {
    cwd: tmpDir,
    reconnectDelayMs: 1000,
    skipMinerCheck: true,
    watchdogIntervalMs: 1000,
  });
  captureOutput(app, output);

  try {
    await app.run();
    await withTimeout(pool.login, 15000, `${miner.name  } Multi-Miner did not login to fake pool`);
    const outcome = await waitForOutcome(pool, miner, output);
    if (miner.algo === "pearlhash" && pool.submits.length > 0) {
      assert.equal(pool.submits[0].params.proof_encoding, "gzip");
    }
    assertMinerProtocol(app, miner);
    const rates = extractHashrates(output.join("\n"), miner.algo).map((rate) => rate.hashrate);
    const rawCapturePath = writeCapture(miner.name, output, CAPTURE_DIR || tmpDir);
    return { name: miner.name, status: "passed", outcome, protocol: app.minerServer.protocol, rates, rawCapturePath };
  } catch (error) {
    const rawCapturePath = writeCapture(miner.name, [...output, String(error.stack || error)], CAPTURE_DIR || tmpDir);
    return { name: miner.name, status: "failed", failureClass: safeFailureClass(error), rawCapturePath,
      nativeCode: error.nativeCode, nativeSignal: error.nativeSignal };
  } finally {
    await app.stop();
    await pool.close();
  }
}

function minerCommandContext(miner, tmpDir, resolved = resolvedMinerPaths) {
  return {
    tmpDir,
    xmrigCudaLoader: miner.cudaBinary ? findMinerBinary(...miner.cudaBinary.split("/", 2), resolved[miner.cudaBinary.split("/", 1)[0]]) : "",
  };
}

async function waitForOutcome(pool, miner, output) {
  const started = Date.now();
  const timeoutMs = miner.algo === "c29" ? C29_LIVE_TIMEOUT_MS : miner.algo === "kawpow" ? KAWPOW_LIVE_TIMEOUT_MS : LIVE_TIMEOUT_MS;
  let outcome = "";
  while (Date.now() - started < timeoutMs) {
    if (pool.submits.length > 0) outcome = "submit";
    if (outcome && (!WAIT_HASHRATE || extractHashrates(output.join("\n"), miner.algo).length > 0)) return outcome;
    await delay(500);
  }
  throw new Error("timed out before a submit");
}

function assertMinerProtocol(app, miner) {
  const expected = expectedProtocol(miner);
  if (!expected) return;
  assert.equal(app.minerServer.protocol, expected, `expected miner protocol ${  expected  } but saw ${  app.minerServer.protocol}`);
}

function expectedProtocol(miner) {
  if (miner.expectedProtocol) return miner.expectedProtocol;
  if (miner.kind === "pearl") return "eth";
  if (miner.kind === "default" || miner.kind === "grin") return miner.kind;
  if (miner.name.includes("ethproxy")) return "ethproxy";
  if (miner.name === "rigel-etchash") return "ethproxy";
  if (miner.name === "trex-etchash") return "ethproxy";
  return miner.kind === "eth" ? "eth" : "";
}

function scriptCommand(minerDir, command, resolved = resolvedMinerPaths) {
  const dir = findMinerCommandDir(minerDir, command, resolved[minerDir]);
  if (!dir) return "";
  const inner = `cd ${  shellQuote(dir)  } && ${  command}`;
  if (fs.existsSync("/usr/bin/script")) return `/usr/bin/script -q -c ${  quoteForCommand(inner)  } /dev/null`;
  return `/bin/sh -lc ${  quoteForCommand(inner)}`;
}

function hasNvidiaGpu() {
  const result = childProcess.spawnSync("nvidia-smi", [], { encoding: "utf8" });
  return result.status === 0 && /NVIDIA/i.test(result.stdout);
}

function printResult(result) {
  process.stdout.write(`live-nvidia-gpu-miners: ${safeResultSummary(result)}\n`);
}

function writeCapture(name, output, captureDir = CAPTURE_DIR) {
  const directory = captureDir || fs.mkdtempSync(path.join(os.tmpdir(), "mm-live-capture-"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const capturePath = path.join(directory, `${name  }.log`);
  fs.writeFileSync(capturePath, `${output.join("\n").slice(-4 * 1024 * 1024)}\n`, { mode: 0o600 });
  fs.chmodSync(capturePath, 0o600);
  return capturePath;
}

module.exports = { minerCommandContext, scriptCommand, writeCapture };
