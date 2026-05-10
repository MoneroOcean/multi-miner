#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MultiMinerApp } = require("../mm");
const { assertNoLiveFailures, captureOutput, envInt, freePort, printSimpleResult, quoteForCommand, selectedCases, shellQuote, tail, waitForLiveSubmit, withTimeout, words, writeLiveConfig } = require("./common/live-helpers");
const { assertEasyEthTargets, createLiveFakePool } = require("./common/live-fake-pool");
const { ensureMinerBinaries } = require("./common/live-miner-downloads");
const { findConfiguredMinerBinary } = require("./common/live-miner-cache");

const LIVE_TIMEOUT_MS = envInt("MM_LIVE_TIMEOUT_MS", 90000);
const KAWPOW_LIVE_TIMEOUT_MS = envInt("MM_LIVE_KAWPOW_TIMEOUT_MS", 180000);
const C29_LIVE_TIMEOUT_MS = envInt("MM_LIVE_C29_TIMEOUT_MS", 600000);
const MOMINER_C29_DEVICE = process.env.MM_LIVE_MOMINER_C29_DEVICE || "gpu1*1";
const MOMINER_NO_BENCH_ALGOS = words(`
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
  { algo: "c29", miner: "mominer", name: "mominer-c29" },
];
assertEasyEthTargets(GPU_CASES);
main().catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});

async function main() {
  const hasIntelGpu = hasIntelOpenClGpu();
  if (hasIntelGpu) await ensureMinerBinaries(["srbminer-multi", "mominer"]);
  const binaries = {
    mominer: findMoMiner(),
    srbminer: findSrbMiner(),
  };
  const results = [];

  for (const testCase of selectedCases(GPU_CASES, "MM_LIVE_INTEL_GPU_CASES")) {
    const result = !binaries[testCase.miner]
      ? { name: testCase.name, status: "skipped", reason: testCase.miner + " binary not found" }
      : !hasIntelGpu
        ? { name: testCase.name, status: "skipped", reason: "Intel OpenCL GPU not found" }
        : await runCase(binaries[testCase.miner], testCase);
    results.push(result);
    printSimpleResult("live-intel-gpu-miners", result);
  }

  assertNoLiveFailures(assert, results);
}

async function runCase(binary, testCase) {
  const minerPort = await freePort();
  const pool = await createLiveFakePool(testCase);
  const output = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-intel-gpu-live-"));
  const args = appArgs(binary, testCase, minerPort, pool.port, tmpDir);
  const app = new MultiMinerApp(args, {
    checkTimeoutMs: testCase.miner === "mominer" ? 60000 : 8000,
    cwd: tmpDir,
    reconnectDelayMs: 1000,
    skipMinerCheck: true,
    watchdogIntervalMs: 1000,
  });
  captureOutput(app, output);

  try {
    await withTimeout(app.run(), testCase.miner === "mominer" ? 75000 : 15000, testCase.name + " Multi-Miner did not start");
    const login = await withTimeout(pool.login, 15000, testCase.name + " Multi-Miner did not log in to fake pool");
    assert.equal(login.method, "login");
    assert.ok(login.params.algo.includes(testCase.algo));
    const outcome = await waitForOutcome(pool, testCase, output);
    return { name: testCase.name, status: "passed", outcome };
  } catch (error) {
    const text = output.join("\n");
    if (isUnsupportedOutput(text)) return { name: testCase.name, status: "skipped", reason: "unsupported by this " + testCase.miner + " build or device" };
    return { name: testCase.name, status: "failed", reason: error.message, output: tail(text) };
  } finally {
    cleanupMoMiner(testCase);
    await app.stop();
    await pool.close();
  }
}

function appArgs(binary, testCase, minerPort, poolPort, tmpDir) {
  const command = testCase.miner === "mominer"
    ? moMinerCommand(binary, testCase, minerPort, tmpDir)
    : srbMinerCommand(binary, testCase, minerPort);
  const configPath = path.join(tmpDir, "mm.json");
  writeLiveConfig(configPath, minerPort, poolPort, testCase.algo, command);
  const args = [configPath, "--no-config-save"];
  if (process.env.MM_LIVE_DEBUG) args.push("--verbose", "--debug");
  return args;
}

function findSrbMiner() {
  return findConfiguredMinerBinary("SRBMINER_PATH", "srbminer-multi", process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI");
}

function findMoMiner() {
  return findConfiguredMinerBinary("MOMINER_PATH", "mominer", "mominer.js");
}

function hasIntelOpenClGpu() {
  const result = childProcess.spawnSync("clinfo", [], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return /Device Type\s+GPU/i.test(result.stdout) && /Intel\(R\)|Intel Corporation|Intel/i.test(result.stdout);
}

function srbMinerCommand(binary, testCase, minerPort) {
  const dir = path.dirname(binary);
  const exe = "./" + path.basename(binary);
  const stableGpuArgs = testCase.algo === "cn/gpu" || testCase.algo === "autolykos2"
    ? "--gpu-intensity 1 --gpu-disable-interleaving --disable-gpu-dual-kernels --autotune-no-load --busy-wait-recheck 0.01 --extended-log"
    : "";
  const inner = [
    "cd " + shellQuote(dir),
    "&&",
    shellQuote(exe),
    "--algorithm " + shellQuote(testCase.minerAlgo),
    "--pool 127.0.0.1:" + minerPort,
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
  if (fs.existsSync("/usr/bin/script")) return "/usr/bin/script -q -c " + quoteForCommand(inner) + " /dev/null";
  return "/bin/sh -lc " + quoteForCommand(inner);
}

function moMinerCommand(binary, testCase, minerPort, tmpDir) {
  const configPath = path.join(tmpDir, "mominer-config.json");
  fs.writeFileSync(configPath, JSON.stringify(moMinerConfig(testCase, minerPort), null, 2));
  const rootDir = path.dirname(binary);
  if (canUseMoMinerDocker(rootDir)) return moMinerDockerCommand(rootDir, tmpDir);
  const libPath = [rootDir, path.join(rootDir, "lib"), path.join(rootDir, "lib64"), process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
  const inner = [
    "cd " + shellQuote(rootDir),
    "&&",
    "MOMINER_CONFIG_DIR=" + shellQuote(tmpDir),
    "LD_LIBRARY_PATH=" + shellQuote(libPath),
    shellQuote(process.execPath),
    shellQuote(binary),
    "mine",
    shellQuote(configPath),
  ].join(" ");
  return "/bin/sh -lc " + quoteForCommand(inner);
}

function moMinerDockerCommand(rootDir, tmpDir) {
  const image = process.env.MM_LIVE_MOMINER_DOCKER_IMAGE || "mominer-deploy";
  testDockerImage(rootDir, image);
  const containerName = "mm-mominer-" + process.pid + "-" + Date.now();
  const configArg = "/root/mominer-live/mominer-config.json";
  moMinerDockerCommand.containerName = containerName;
  return [
    shellQuote("docker"),
    "run",
    "--privileged",
    "--rm",
    "--network", "host",
    "--name", shellQuote(containerName),
    "--mount", shellQuote("type=bind,source=" + rootDir + ",target=/root/mominer"),
    "--mount", shellQuote("type=bind,source=" + tmpDir + ",target=/root/mominer-live"),
    "--workdir", "/root/mominer",
    shellQuote(image),
    "node",
    "mominer.js",
    "mine",
    shellQuote(configArg),
  ].join(" ");
}

function canUseMoMinerDocker(rootDir) {
  return commandOk("docker", ["--version"]) && fs.existsSync(path.join(rootDir, "deploy.dockerfile"));
}

function testDockerImage(rootDir, image) {
  if (commandOk("docker", ["image", "inspect", image])) return;
  childProcess.spawnSync("docker", ["build", "-q", "-t", image, "-f", "deploy.dockerfile", "."], {
    cwd: rootDir,
    encoding: "utf8",
  });
}

function cleanupMoMiner(testCase) {
  if (testCase.miner !== "mominer" || !moMinerDockerCommand.containerName) return;
  childProcess.spawnSync("docker", ["rm", "-f", moMinerDockerCommand.containerName], { encoding: "utf8" });
  moMinerDockerCommand.containerName = "";
}

function commandOk(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
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
      donate_length: 0,
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
    algo_params: Object.fromEntries(MOMINER_NO_BENCH_ALGOS.map((algorithm) => [algorithm, {
      dev: algorithm === "c29" || algorithm === "cn/gpu" ? MOMINER_C29_DEVICE : "cpu",
      perf: 1,
    }])),
    default_msrs: {},
    log_level: 0,
  };
}

async function waitForOutcome(pool, testCase, output) {
  const timeoutMs = testCase.algo === "c29" ? C29_LIVE_TIMEOUT_MS : testCase.algo === "kawpow" ? KAWPOW_LIVE_TIMEOUT_MS : LIVE_TIMEOUT_MS;
  return await waitForLiveSubmit(pool, testCase.name, output, timeoutMs);
}

function isUnsupportedOutput(output) {
  return /unsupported|not supported|unknown algorithm|invalid algorithm|algorithm.*not.*found|no device|can't find .*device|libsvml\.so|ERR_DLOPEN_FAILED|was not connected and will be ignored|You need to define at least 1 valid algorithm/i.test(output);
}
