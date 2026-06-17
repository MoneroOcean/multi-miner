#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MultiMinerApp } = require("../mm");
const { extractHashrates } = require("../src/hashrate");
const { assertNoLiveFailures, captureOutput, delay, envInt, freePort, quoteForCommand, selectedCases, shellQuote, tail, withTimeout, writeLiveConfig } = require("./common/live-helpers");
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

const MINERS = nvidiaMinerPlans(scriptCommand, WALLET);
assertEasyEthTargets(MINERS);

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)  }\n`);
  process.exitCode = 1;
});

async function main() {
  const miners = selectedCases(MINERS, "MM_LIVE_NVIDIA_GPU_MINERS");
  if (!hasNvidiaGpu()) {
    for (const miner of miners) printResult({ name: miner.name, status: "skipped", reason: "NVIDIA GPU not found" });
    return;
  }
  await ensureMinerBinaries(miners.flatMap((miner) => [miner.binary, miner.cudaBinary].filter(Boolean).map((value) => value.split("/", 1)[0])));
  const results = [];
  for (const miner of miners) {
    const result = await runMiner(miner);
    results.push(result);
    printResult(result);
  }
  assertNoLiveFailures(assert, results);
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
    assertMinerProtocol(app, miner);
    const rates = extractHashrates(output.join("\n"), miner.algo).map((rate) => rate.hashrate);
    writeCapture(miner.name, output);
    return { name: miner.name, status: "passed", outcome, protocol: app.minerServer.protocol, rates };
  } catch (error) {
    writeCapture(miner.name, output);
    return { name: miner.name, status: "failed", reason: error.message, output: tail(output.join("\n")) };
  } finally {
    await app.stop();
    await pool.close();
  }
}

function minerCommandContext(miner, tmpDir) {
  return {
    tmpDir,
    xmrigCudaLoader: miner.cudaBinary ? findMinerBinary(...miner.cudaBinary.split("/", 2)) : "",
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
  throw new Error(`timed out; tail:\n${  tail(output.join("\n"))}`);
}

function assertMinerProtocol(app, miner) {
  const expected = expectedProtocol(miner);
  if (!expected) return;
  assert.equal(app.minerServer.protocol, expected, `expected miner protocol ${  expected  } but saw ${  app.minerServer.protocol}`);
}

function expectedProtocol(miner) {
  if (miner.expectedProtocol) return miner.expectedProtocol;
  if (miner.kind === "default" || miner.kind === "grin") return miner.kind;
  if (miner.name.includes("ethproxy")) return "ethproxy";
  if (miner.name === "rigel-etchash") return "ethproxy";
  if (miner.name === "trex-etchash") return "ethproxy";
  return miner.kind === "eth" ? "eth" : "";
}

function scriptCommand(minerDir, command) {
  const dir = findMinerCommandDir(minerDir, command);
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
  const suffix = result.status === "passed" ? ` (${  result.outcome  }, protocol=${  result.protocol  }, rates=${  result.rates.length  })` : result.reason;
  process.stdout.write(`live-nvidia-gpu-miners: ${  result.name  } ${  result.status  } ${  suffix  }\n`);
  if (result.output) process.stdout.write(`${result.output  }\n`);
}

function writeCapture(name, output) {
  if (!CAPTURE_DIR) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, `${name  }.log`), `${output.join("\n")  }\n`);
}
