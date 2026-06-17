"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const { MultiMinerApp } = require("../mm");
const { createFakePool, fakeMinerCommand, freePort } = require("./common/helpers");

describe("fake-pool integration", { concurrency: false }, () => {
  it("logs in, switches algo, and forwards miner submit", async () => {
    const minerPort = await freePort();
    const pool = await createFakePool("rx/0");
    const app = new MultiMinerApp([
      "--no-config-save",
      "--watchdog=0",
      `--pool=127.0.0.1:${  pool.port}`,
      "--user=wallet",
      "--pass=x",
      `--port=${  minerPort}`,
      "--perf_rx/0=1",
      `--rx/0=${  fakeMinerCommand(minerPort, "default", "rx/0")}`,
    ], appOptions());

    try {
      await app.run();
      const login = await pool.login;
      assert.equal(login.method, "login");
      assert.ok(login.params.algo.includes("rx/0"));
      const submit = await pool.submit;
      assert.equal(submit.method, "submit");
    } finally {
      await app.stop();
      await pool.close();
    }
  });

  it("supports ETH subscribe/authorize protocol helpers", async () => {
    const minerPort = await freePort();
    const pool = await createFakePool("etchash", "eth");
    const app = new MultiMinerApp([
      "--no-config-save",
      "--watchdog=0",
      `--pool=127.0.0.1:${  pool.port}`,
      "--user=wallet",
      "--pass=x",
      `--port=${  minerPort}`,
      "--perf_etchash=1",
      `--etchash=${  fakeMinerCommand(minerPort, "eth", "etchash")}`,
    ], appOptions());

    try {
      await app.run();
      await pool.login;
      const submit = await pool.submit;
      assert.equal(submit.method, "mining.submit");
    } finally {
      await app.stop();
      await pool.close();
    }
  });

  it("supports ETH proxy login/getWork/submitWork helpers", async () => {
    const minerPort = await freePort();
    const pool = await createFakePool("etchash", "eth");
    const app = new MultiMinerApp([
      "--no-config-save",
      "--watchdog=0",
      `--pool=127.0.0.1:${  pool.port}`,
      "--user=wallet",
      "--pass=x",
      `--port=${  minerPort}`,
      "--perf_etchash=1",
      `--etchash=${  fakeMinerCommand(minerPort, "ethproxy", "etchash")}`,
    ], appOptions());

    try {
      await app.run();
      await pool.login;
      const submit = await pool.submit;
      assert.equal(submit.method, "mining.submit");
    } finally {
      await app.stop();
      await pool.close();
    }
  });
});

function appOptions() {
  return { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-app-")), reconnectDelayMs: 1000 };
}
