#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MultiMinerApp } = require("../mm");
const { assertNoLiveFailures, captureOutput, envInt, freePort, printSimpleResult, quoteForCommand, safeFailureClass, selectedCases, shellQuote, waitForLiveSubmit, withTimeout, words, writePrivateFile, writeLiveConfig } = require("./common/live-helpers");
const { assertEasyEthTargets, createLiveFakePool } = require("./common/live-fake-pool");
const { ensureMinerBinaries } = require("./common/live-miner-downloads");
const { findConfiguredMinerBinary } = require("./common/live-miner-cache");

const LIVE_TIMEOUT_MS = envInt("MM_LIVE_TIMEOUT_MS", 90000);
const KAWPOW_LIVE_TIMEOUT_MS = envInt("MM_LIVE_KAWPOW_TIMEOUT_MS", 180000);
const C29_LIVE_TIMEOUT_MS = envInt("MM_LIVE_C29_TIMEOUT_MS", 600000);
// C29's inline main value is seed_workgroup (64/128/256), not intensity; bare gpu1 keeps
// the published release's bounded auto-tuning while selecting only the discrete Intel device.
const MOM_C29_DEVICE = process.env.MM_LIVE_MOM_C29_DEVICE || "gpu1";
const MOM_NO_BENCH_ALGOS = words(`
  argon2/chukwa argon2/chukwav2 argon2/wrkz c29 cn-heavy/0 cn-heavy/tube cn-heavy/xhv
  cn-lite/0 cn-lite/1 cn-pico/0 cn-pico/tlo cn/0 cn/1 cn/2 cn/ccx cn/double cn/fast
  cn/half cn/gpu cn/r cn/rto cn/rwz cn/upx2 cn/xao cn/zls ghostrider panthera
  rx/0 rx/arq rx/graft rx/sfx rx/wow rx/yada
`);
const GPU_CASES = [
  { algo: "cn/gpu", miner: "srbminer", minerAlgo: "cryptonight_gpu", name: "srbminer-cn-gpu" },
  { algo: "autolykos2", kind: "eth", miner: "srbminer", minerAlgo: "autolykos2", name: "srbminer-autolykos2" },
  { algo: "etchash", extraArgs: "--esm 1", kind: "eth", miner: "srbminer", minerAlgo: "etchash", name: "srbminer-etchash" },
  { algo: "etchash", extraArgs: "--esm 2", kind: "eth", miner: "srbminer", minerAlgo: "etchash", name: "srbminer-etchash-ethstratum2" },
  { algo: "etchash", extraArgs: "--esm 0", kind: "eth", miner: "srbminer", minerAlgo: "etchash", name: "srbminer-etchash-ethproxy" },
  { algo: "kawpow", kind: "eth", miner: "srbminer", minerAlgo: "kawpow", name: "srbminer-kawpow" },
  { algo: "c29", miner: "mom", name: "mom-c29" },
];
assertEasyEthTargets(GPU_CASES);
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`live-intel-gpu-miners: status=failed failure=${safeFailureClass(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-intel-extraction-"));
  let stopped = true;
  try {
    const hasIntelGpu = hasIntelOpenClGpu();
    const selected = selectedCases(GPU_CASES, "MM_LIVE_INTEL_GPU_CASES");
    const binaries = hasIntelGpu ? await resolveMinerPathsForRun(extractionRoot) : {};
    const results = [];

    for (const testCase of selected) {
      stopped = false;
      const result = !hasIntelGpu || !binaries[testCase.miner]
        ? unavailableCaseResult(testCase, hasIntelGpu)
        : await runCase(binaries[testCase.miner], testCase);
      stopped = true;
      results.push(result);
      printSimpleResult("live-intel-gpu-miners", result);
    }

    assertNoLiveFailures(assert, results);
  } finally {
    if (stopped) fs.rmSync(extractionRoot, {recursive: true, force: true});
  }
}

function unavailableCaseResult(testCase, hasIntelGpu) {
  if (!hasIntelGpu) {
    return { name: testCase.name, status: "skipped", reason: "Intel OpenCL GPU not found" };
  }
  if (testCase.miner === "mom") {
    return { name: testCase.name, status: "failed", reason: "required MoM binary unavailable" };
  }
    return { name: testCase.name, status: "skipped", reason: `${testCase.miner  } binary not found` };
}

async function runCase(binary, testCase) {
  const minerPort = await freePort();
  const pool = await createLiveFakePool(testCase);
  const output = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-intel-gpu-live-"));
  const rawCapturePath = path.join(tmpDir, `${testCase.name}.output`);
  const args = appArgs(binary, testCase, minerPort, pool.port, tmpDir);
  const app = new MultiMinerApp(args, {
    checkTimeoutMs: testCase.miner === "mom" ? 60000 : 8000,
    cwd: tmpDir,
    reconnectDelayMs: 1000,
    skipMinerCheck: true,
    watchdogIntervalMs: 1000,
  });
  const minerExit = observeMinerExit(app);
  captureOutput(app, output);

  try {
    await withTimeout(app.run(), testCase.miner === "mom" ? 75000 : 15000, `${testCase.name  } Multi-Miner did not start`);
    const login = await withTimeout(pool.login, 15000, `${testCase.name  } Multi-Miner did not log in to fake pool`);
    assert.equal(login.method, "login");
    assert.ok(login.params.algo.includes(testCase.algo));
    const outcome = await waitForOutcome(pool, testCase, output, minerExit);
    writePrivateFile(rawCapturePath, output.join("\n"));
    return { name: testCase.name, status: "passed", outcome, rawCapturePath };
  } catch (error) {
    const text = output.join("\n");
    writePrivateFile(rawCapturePath, `${text}\n${String(error.stack || error)}`.slice(-4 * 1024 * 1024));
    if (isUnsupportedOutput(text)) return { name: testCase.name, status: "skipped", failureClass: "unsupported", rawCapturePath };
    return { name: testCase.name, status: "failed", failureClass: safeFailureClass(error), rawCapturePath,
      nativeCode: error.nativeCode, nativeSignal: error.nativeSignal };
  } finally {
    await app.stop();
    await pool.close();
  }
}

/**
 * Observe the first miner child, including a synchronous launch failure. A dead child must fail
 * the bounded live case immediately instead of waiting for the much longer fake-pool submit bound.
 * @param {MultiMinerApp} app
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null, phase: string}> & {exit: Promise<{code: number | null, signal: NodeJS.Signals | null, phase: string}>}}
 */
function observeMinerExit(app) {
  let resolveExit;
  let resolveClose;
  let exitObserved = false;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });
  closePromise.exit = exitPromise;
  const finishExit = (state) => {
    if (exitObserved) return;
    exitObserved = true;
    resolveExit(state);
  };
  let observed = false;
  const observe = (child) => {
    if (!child || observed) return child;
    observed = true;
    child.once("exit", (code, signal) => finishExit({code, signal, phase: "exit"}));
    child.once("close", (code, signal) => {
      resolveClose({code, signal, phase: "close"});
      // ChildProcess normally emits exit first, but retain a close fallback for
      // test doubles and launch wrappers that only expose the final stream event.
      finishExit({code, signal, phase: "close"});
    });
    return child;
  };
  const startMinerProcess = app.startMinerProcess.bind(app);
  app.startMinerProcess = (...args) => {
    const child = startMinerProcess(...args);
    if (!child) {
      const state = {code: null, signal: null, phase: "launch"};
      finishExit(state);
      resolveClose(state);
    }
    return observe(child);
  };
  return closePromise;
}

function appArgs(binary, testCase, minerPort, poolPort, tmpDir) {
  const command = testCase.miner === "mom"
    ? moMinerCommand(binary, testCase, minerPort, tmpDir)
    : srbMinerCommand(binary, testCase, minerPort);
  const configPath = path.join(tmpDir, "mm.json");
  writeLiveConfig(configPath, minerPort, poolPort, testCase.algo, command);
  const args = [configPath, "--no-config-save"];
  if (process.env.MM_LIVE_DEBUG) args.push("--verbose", "--debug");
  return args;
}

function resolveMinerPaths(resolved = {}) {
  return {
    "mom": findMom(resolved),
    srbminer: findSrbMiner(resolved),
  };
}

async function resolveMinerPathsForRun(extractionRoot) {
  const configured = resolveMinerPaths({mom: "", "srbminer-multi": ""});
  const needed = [configured.mom ? "" : "mom", configured.srbminer ? "" : "srbminer-multi"].filter(Boolean);
  return resolveMinerPaths(await ensureMinerBinaries(needed, {extractionRoot}));
}

function findSrbMiner(resolved = {}) {
  return findConfiguredMinerBinary("SRBMINER_PATH", "srbminer-multi", process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI", resolved["srbminer-multi"]);
}

function findMom(resolved = {}) {
  const binaryName = process.platform === "win32" ? "mom.cmd" : "mom";
  return findConfiguredMinerBinary("MOM_PATH", "mom", binaryName, resolved.mom);
}

function hasIntelOpenClGpu() {
  const result = childProcess.spawnSync("clinfo", [], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return /Device Type\s+GPU/i.test(result.stdout) && /Intel\(R\)|Intel Corporation|Intel/i.test(result.stdout);
}

function srbMinerCommand(binary, testCase, minerPort) {
  const dir = path.dirname(binary);
  const exe = `./${  path.basename(binary)}`;
  const stableGpuArgs = testCase.algo === "cn/gpu" || testCase.algo === "autolykos2"
    ? "--gpu-intensity 1 --gpu-disable-interleaving --disable-gpu-dual-kernels --autotune-no-load --busy-wait-recheck 0.01 --extended-log"
    : "";
  const inner = [
    `cd ${  shellQuote(dir)}`,
    "&&",
    shellQuote(exe),
    `--algorithm ${  shellQuote(testCase.minerAlgo)}`,
    `--pool 127.0.0.1:${  minerPort}`,
    "--wallet wallet",
    "--password x",
    testCase.extraArgs || "",
    "--disable-cpu --disable-gpu-amd --disable-gpu-nvidia --gpu-id 0",
    "--retry-time 1",
    "--job-timeout 0",
    "--gpu-sensors-disable",
    "--disable-worker-watchdog",
    stableGpuArgs,
  ].join(" ");
  if (fs.existsSync("/usr/bin/script")) return `/usr/bin/script -q -c ${  quoteForCommand(inner)  } /dev/null`;
  return `/bin/sh -lc ${  quoteForCommand(inner)}`;
}

function moMinerCommand(binary, testCase, minerPort, tmpDir) {
  const configPath = path.join(tmpDir, "mom-config.json");
  writePrivateFile(configPath, JSON.stringify(moMinerConfig(testCase, minerPort), null, 2));
  const rootDir = path.dirname(binary);
  if (process.platform === "win32") return [quoteForCommand(binary), "mine", quoteForCommand(configPath)].join(" ");
  const libPath = [rootDir, path.join(rootDir, "lib"), path.join(rootDir, "lib64"), process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
  const inner = [
    `cd ${  shellQuote(rootDir)}`,
    "&&",
    `MOM_CONFIG_DIR=${  shellQuote(tmpDir)}`,
    `LD_LIBRARY_PATH=${  shellQuote(libPath)}`,
    shellQuote(binary),
    "mine",
    shellQuote(configPath),
  ].join(" ");
  return `/bin/sh -lc ${  quoteForCommand(inner)}`;
}

function moMinerConfig(testCase, minerPort) {
  return {
    pool_time: {
      stats: 30,
      connect_throttle: 5,
      primary_reconnect: 30,
      first_job_wait: Math.max(5, Math.ceil(LIVE_TIMEOUT_MS / 3000)),
      close_wait: 2,
      donate_interval: 86400,
      // MoM 0.9 validates timer fields as positive; a null donation pool keeps this case primary-only.
      donate_length: 60,
      keepalive: 30,
    },
    pools: [{
      url: "127.0.0.1",
      port: minerPort,
      is_tls: false,
      is_nicehash: false,
      is_keepalive: true,
      login: "wallet",
      pass: "x",
    }],
    pool_ids: { primary: 0, donate: null },
    algo_params: Object.fromEntries(MOM_NO_BENCH_ALGOS.map((algorithm) => [algorithm, {
      dev: algorithm === "c29" || algorithm === "cn/gpu" ? MOM_C29_DEVICE : "cpu",
      perf: 1,
    }])),
    default_msrs: {},
    log_level: 0,
    // mom v0.7.0 benchmarks the active MoneroOcean GPU algos (autolykos2/etchash/kawpow/pearl) at
    // startup by default (bench_algo_params=1); they aren't in MOM_NO_BENCH_ALGOS, so without this the
    // live test triggers slow -- and on some Intel Xe GPUs unstable -- DAG benchmarks before mining.
    bench_algo_params: 0,
  };
}

async function waitForOutcome(pool, testCase, output, minerExit) {
  const timeoutMs = testCase.algo === "c29" ? C29_LIVE_TIMEOUT_MS : testCase.algo === "kawpow" ? KAWPOW_LIVE_TIMEOUT_MS : LIVE_TIMEOUT_MS;
  const earlyExit = minerExit && minerExit.exit ? minerExit.exit : minerExit;
  return await waitForLiveSubmit(pool, testCase.name, output, timeoutMs, earlyExit);
}

function isUnsupportedOutput(output) {
  return /unsupported|not supported|unknown algorithm|invalid algorithm|algorithm.*not.*found|no device|can't find .*device|libsvml\.so|ERR_DLOPEN_FAILED|was not connected and will be ignored|You need to define at least 1 valid algorithm/i.test(output);
}

module.exports = { moMinerCommand, observeMinerExit, resolveMinerPaths, resolveMinerPathsForRun, unavailableCaseResult, waitForOutcome };
