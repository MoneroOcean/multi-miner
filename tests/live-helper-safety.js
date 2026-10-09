"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {test} = require("node:test");

const {MultiMinerApp} = require("../mm");
const {runCase: runCpuCase} = require("./live-cpu-miners");

const {assertNoLiveFailures, safeFailureClass, safeResultSummary, waitForLiveSubmit, writeLiveConfig} = require("./common/live-helpers");
const {writeCapture} = require("./live-nvidia-gpu-miners");

const PRIVATE_OUTPUT_SOURCES = [
  path.join(__dirname, 'live-cpu-miners.js'),
  path.join(__dirname, "live-intel-gpu-miners.js"),
  path.join(__dirname, "live-nvidia-gpu-miners.js"),
  path.join(__dirname, "common", "live-miner-downloads.js"),
];

test("CPU top-level failures emit only a fixed classification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-cpu-safe-error-"));
  const preload = path.join(root, "preload.cjs");
  const privateMarker = "private-cpu-fixture-diagnostic";
  try {
    fs.writeFileSync(preload, `require("node:fs").mkdtempSync = () => { throw new Error(${JSON.stringify(privateMarker)}); };`);
    const result = childProcess.spawnSync(process.execPath,
      ["--require", preload, path.join(__dirname, "live-cpu-miners.js")],
      {encoding: "utf8", timeout: 5000, maxBuffer: 16384});
    assert.equal(result.status, 1);
    assert.equal(result.stdout.length, 0);
    assert.equal(result.stderr === "[live:cpu] failure=runtime\n", true, "CPU failure output is classified");
    assert.equal(result.stderr.includes(privateMarker), false, "private diagnostic is suppressed");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("CPU case failures retain a private bounded capture without returning raw output", async (t) => {
  const privateMarker = "private-cpu-case-diagnostic";
  let app;
  t.mock.method(MultiMinerApp.prototype, "run", async function () {
    app = this;
    this.logger.miner("x".repeat(3 * 1024 * 1024));
    throw new Error(privateMarker);
  });
  const stop = t.mock.method(MultiMinerApp.prototype, "stop", async () => {});
  let result;
  try {
    result = await runCpuCase(process.execPath, {name: "cpu_fixture", algo: "rx/0"});
    assert.equal(result.status, "failed");
    assert.equal(result.failureClass, "runtime");
    assert.equal(Object.hasOwn(result, "output"), false);
    assert.equal(Object.hasOwn(result, "reason"), false);
    assert.equal(path.dirname(result.rawCapturePath), app.options.cwd);
    const capture = fs.readFileSync(result.rawCapturePath, "utf8");
    assert.equal(capture.includes(privateMarker), true, "private diagnostic remains available in capture");
    assert.equal(capture.length <= 2 * 1024 * 1024, true, "failure capture stays bounded");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(result.rawCapturePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(result.rawCapturePath)).mode & 0o777, 0o700);
    }
    assert.equal(stop.mock.callCount(), 1, "CPU case still awaits cleanup");
  } finally {
    if (result) fs.rmSync(path.dirname(result.rawCapturePath), {recursive: true, force: true});
  }
});

test("fixed failure classes survive repeated safe projection", () => {
  for (const failureClass of ["timeout", "unsupported", "binary-unavailable", "permission",
    "native-exit", "pool-startup", "submit", "protocol", "assertion", "runtime"]) {
    assert.equal(safeFailureClass(failureClass), failureClass);
  }
  assert.match(safeResultSummary({name: "fixture-case", status: "failed",
    failureClass: safeFailureClass("binary not found")}), /failure=binary-unavailable/);
});

test("live failure projections exclude raw reason and output fields", () => {
  const result = {
    name: "fixture-case",
    status: "failed",
    reason: "timeout at private endpoint wallet-secret",
    output: "private miner command and password",
    nativeCode: 17,
    nativeSignal: "SIGTERM",
  };
  assert.equal(safeResultSummary(result), "case=fixture-case status=failed failure=timeout nativeCode=17 nativeSignal=SIGTERM");
  assert.throws(() => assertNoLiveFailures(assert, [result]), (error) => {
    assert.match(error.message, /live failure count=1\/1/);
    assert.match(error.message, /failure=timeout nativeCode=17 nativeSignal=SIGTERM/);
    assert.equal(error.message.includes("private"), false);
    assert.equal(error.message.includes("wallet"), false);
    return true;
  });
});

test("live configs and captures remain private under a permissive umask", {skip: process.platform === 'win32' && 'POSIX permission bits are not supported on Windows'}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-live-helper-safety-"));
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, {mode: 0o777});
  const configPath = path.join(configDir, "mm.json");
  const captureDir = path.join(root, "captures");
  const previousUmask = process.umask(0o000);
  try {
    writeLiveConfig(configPath, 10001, 10002, "fixture", "private command");
    writeCapture("fixture-case", ["private capture"], captureDir);
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(captureDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(captureDir, "fixture-case.log")).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("live failure paths do not project exception payloads", () => {
  for (const sourcePath of PRIVATE_OUTPUT_SOURCES) {
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.equal(/reason:\s*error\.message/.test(source), false, sourcePath);
    assert.equal(/output:\s*tail\(/.test(source), false, sourcePath);
    assert.equal(/process\.stderr\.write\([^\n]*(?:error\.message|error\.stack)/.test(source), false, sourcePath);
  }
});

test("unset capture directory still preserves a private failure artifact", () => {
  const capture = writeCapture("fixture-failure", ["private failure output"], "");
  assert.ok(capture, "default failure output must not be discarded");
  try {
    assert.equal(fs.readFileSync(capture, "utf8"), "private failure output\n");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.dirname(capture)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(capture).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(path.dirname(capture), {recursive: true, force: true});
  }
});

test("early child exit keeps native code 17 in the safe failure projection", async () => {
  let failure;
  try {
    await waitForLiveSubmit({submits: []}, "fixture-exit", [], 2000,
      Promise.resolve({code: 17, signal: null}));
  } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.nativeCode, 17);
  assert.equal(failure.nativeSignal, null);
  assert.match(safeResultSummary({name:"fixture-exit", status:"failed", reason:failure.message,
    nativeCode:failure.nativeCode, nativeSignal:failure.nativeSignal}), /failure=native-exit nativeCode=17/);
});
