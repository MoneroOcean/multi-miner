"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const {EventEmitter} = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {test} = require("node:test");

const {MultiMinerApp} = require("../mm");
const {splitCommand} = require("../src/command");
const {createLiveFakePool} = require("./common/live-fake-pool");
const {delay, freePort, quoteForCommand, writeLiveConfig, withTimeout} = require("./common/live-helpers");
const {moMinerCommand, observeMinerExit, unavailableCaseResult, waitForOutcome} = require("./live-intel-gpu-miners");

test("MoM live command carries mine action and JSON config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-mom-command-"));
  try {
    const command = moMinerCommand("/bin/false", {algo: "c29"}, 1, tmpDir);
    const parsed = splitCommand(command);
    const serialized = parsed.args.join("\u0000");
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "mom-config.json"), "utf8"));
    assert.ok(serialized.includes("mine"), "MoM action is missing from the real caller command");
    assert.ok(serialized.includes(path.join(tmpDir, "mom-config.json")), "MoM config path is missing from the real caller command");
    assert.ok(config.pool_time.donate_length > 0, "MoM 0.9 requires a positive donation timer");
    assert.equal(config.pool_ids.donate, null, "the MM c29 case must not enable donation work");
    assert.equal(config.algo_params.c29.dev, "gpu1", "the MM c29 case must use a bare GPU selector");
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test("immediate MoM launcher exit fails before the submit timeout", async () => {
  const child = new EventEmitter();
  const app = {startMinerProcess: () => child};
  const minerExit = observeMinerExit(app);
  const started = Date.now();
  const startedChild = app.startMinerProcess();
  startedChild.emit("close", 17, null);
  await assert.rejects(
    waitForOutcome({submits: []}, {name: "mom-c29", algo: "c29"}, [], minerExit),
    /miner exited before a submit/
  );
  assert.ok(Date.now() - started < 1000, "launcher failure was not reported promptly");
});

test("real app observes child exit before descendant-held stdio closes", {skip: process.platform === 'win32' && 'Requires POSIX signal delivery'}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-observer-process-"));
  const childPath = path.join(tmpDir, "child.js");
  const holdPath = path.join(tmpDir, "hold.js");
  const configPath = path.join(tmpDir, "mm.json");
  const childSource = String.raw`
    const childProcess = require("child_process");
    const net = require("net");
    const port = Number(process.argv[2]);
    const holdPath = process.argv[3];
    let submitted = false;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(JSON.stringify({id: 1, jsonrpc: "2.0", method: "login", params: {
        login: "fixture", pass: "fixture", algo: "c29",
      }}) + '\n');
    });
    socket.on("error", () => {});
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!submitted && message.result && message.result.job) {
          submitted = true;
          socket.write(JSON.stringify({id: 2, jsonrpc: "2.0", method: "submit", params: {
            job_id: "fixture", nonce: "0",
          }}) + '\n');
        }
      }
    });
    process.on("SIGTERM", () => {
      const hold = childProcess.spawn(process.execPath, [holdPath], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      hold.unref();
      setTimeout(() => process.exit(0), 20);
    });
  `;
  fs.writeFileSync(childPath, childSource);
  fs.writeFileSync(holdPath, "setTimeout(() => process.exit(0), 2500); process.on(\"SIGTERM\", () => {});\n");
  const minerPort = await freePort();
  const pool = await createLiveFakePool({name: "mm-observer-process", algo: "c29"});
  const command = [quoteForCommand(process.execPath), quoteForCommand(childPath), String(minerPort), quoteForCommand(holdPath)].join(" ");
  writeLiveConfig(configPath, minerPort, pool.port, "c29", command);
  let app;
  let stopped = false;
  let child;
  let childStarts = 0;
  let resolveChildExit;
  let resolveChildClose;
  const childExit = new Promise((resolve) => { resolveChildExit = resolve; });
  const childClose = new Promise((resolve) => { resolveChildClose = resolve; });
  try {
    app = new MultiMinerApp([configPath, "--no-config-save"], {
      cwd: tmpDir,
      reconnectDelayMs: 1000,
      skipMinerCheck: true,
      watchdogIntervalMs: 1000,
    });
    app.logger.log = () => {};
    app.logger.err = () => {};
    app.logger.miner = () => {};
    const originalStart = app.startMinerProcess.bind(app);
    app.startMinerProcess = (...args) => {
      child = originalStart(...args);
      if (child) childStarts += 1;
      if (child) {
        child.once("exit", (code, signal) => resolveChildExit({code, signal}));
        child.once("close", (code, signal) => resolveChildClose({code, signal}));
      }
      return child;
    };
    const minerExit = observeMinerExit(app);
    await withTimeout(app.run(), 5000, "Multi-Miner did not start the process fixture");
    const login = await Promise.race([pool.login, delay(5000).then(() => null)]);
    assert.ok(login, "the fake pool did not receive the application login");
    const submitDeadline = Date.now() + 5000;
    while (pool.submits.length === 0 && Date.now() < submitDeadline) await delay(25);
    assert.equal(pool.submits.length, 1, "the real child fixture did not submit through the application");
    assert.equal(childStarts, 1, "the fixture unexpectedly started a benchmark child before the runtime child");

    const stopping = app.stop();
    const observedExit = await withTimeout(minerExit.exit, 1000, "observer waited for stdio close instead of child exit");
    assert.equal(observedExit.phase, "exit");
    assert.equal(observedExit.code, 0);
    assert.deepEqual(await withTimeout(childExit, 1000, "child exit event was not observed"), {code: 0, signal: null});
    assert.equal(await Promise.race([childClose, delay(200).then(() => null)]), null, "descendant stdio closed too early for the fixture");
    assert.equal(await Promise.race([minerExit, delay(200).then(() => null)]), null, "observer close state lost the delayed-close distinction");
    await stopping;
    stopped = true;
    assert.deepEqual(await withTimeout(childClose, 4000, "child close event was not observed"), {code: 0, signal: null});
    assert.deepEqual(await withTimeout(minerExit, 1000, "observer close state was not retained"), {code: 0, signal: null, phase: "close"});
  } finally {
    if (app && !stopped) await app.stop().catch(() => {});
    await pool.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test("eligible Intel hardware fails a missing MoM binary while optional miners may skip", () => {
  const mom = {name: "mom-c29", miner: "mom"};
  const optional = {name: "srbminer-c29", miner: "srbminer-multi"};

  assert.deepEqual(unavailableCaseResult(mom, true), {
    name: mom.name,
    status: "failed",
    reason: "required MoM binary unavailable",
  });
  assert.deepEqual(unavailableCaseResult(optional, true), {
    name: optional.name,
    status: "skipped",
    reason: "srbminer-multi binary not found",
  });
  assert.deepEqual(unavailableCaseResult(mom, false), {
    name: mom.name,
    status: "skipped",
    reason: "Intel OpenCL GPU not found",
  });
});

test("eligible Intel orchestration fails when the mandatory MoM resolution is unavailable", {skip: process.platform === 'win32' && 'Requires an executable POSIX clinfo fixture'}, () => {
  const result = runIntelOrchestration({
    clinfo: "Device Type GPU\nIntel(R) Graphics\n",
    downloadMode: "0",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /failure=binary-unavailable/);
});

test("ineligible Intel orchestration skips without resolving miners", {skip: process.platform === 'win32' && 'Requires an executable POSIX clinfo fixture'}, () => {
  const result = runIntelOrchestration({
    clinfo: "Device Type CPU\n",
    downloadMode: "0",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped/);
});

test('documents the canonical Intel device selector', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const selectorLines = readme.split(/\r?\n/).filter((line) => line.includes('MM_LIVE_MOM_C29_DEVICE='));
  assert.equal(selectorLines.length > 0, true);
  assert.equal(selectorLines.every((line) => /MM_LIVE_MOM_C29_DEVICE=gpu1(?:\s|$)/.test(line)), true);
  assert.equal(selectorLines.some((line) => /gpu1\*1/.test(line)), false);
});

function runIntelOrchestration({clinfo, downloadMode}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-intel-orchestration-"));
  const binDir = path.join(tempDir, "bin");
  const cacheDir = path.join(tempDir, "cache");
  const clinfoPath = path.join(binDir, "clinfo");
  fs.mkdirSync(binDir, {recursive: true});
  fs.writeFileSync(clinfoPath, `#!/bin/sh\nprintf '%s' ${JSON.stringify(clinfo)}\n`);
  fs.chmodSync(clinfoPath, 0o755);

  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(__dirname, "live-intel-gpu-miners.js")],
      {
        cwd: __dirname,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ""}`,
          MM_LIVE_INTEL_GPU_CASES: "mom-c29",
          MM_LIVE_DOWNLOAD: downloadMode,
          MM_LIVE_MINER_ROOT: cacheDir,
          MOM_PATH: "",
          SRBMINER_PATH: "",
        },
      }
    );
    return {status: result.status, stdout: result.stdout || "", stderr: result.stderr || ""};
  } finally {
    fs.rmSync(tempDir, {recursive: true, force: true});
  }
}
