"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const { MultiMinerApp } = require("../mm");
const { silentLogger } = require("./common/helpers");

describe("mm lifecycle", () => {
  it("clears the pool-retry reconnect timer on stop()", async () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-stop-")), reconnectDelayMs: 60 * 1000 });
    app.logger = silentLogger();
    app.config.pools = ["127.0.0.1:1"];
    let reconnected = false;
    app.connectPool = () => { reconnected = true; };

    // Exhaust the (single) pool so poolErr schedules the 60s reconnect timer.
    app.currPoolNum = 0;
    app.poolErr(0);
    assert.ok(app.poolReconnectTimer, "reconnect timer was scheduled");

    // Before the fix this timer was untracked, so stop() could not cancel it and it
    // later fired connectPool against torn-down state.
    await app.stop();
    assert.equal(app.poolReconnectTimer, null, "reconnect timer reference is cleared on stop");

    // The timer must not fire after stop(); give the (cancelled) timer a chance.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reconnected, false, "no reconnect is attempted after stop");
  });

  it("nulls minerProc on a non-respawn close so a stale handle can't wedge replaceMiner (#4)", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-close-")) });
    app.logger = silentLogger();
    app.minerProc = { pid: 1234 }; // a now-dead proc handle
    app.currPoolSocket = null;     // non-respawn path (pool down)
    app.handleMinerProcessClose("xmrig", 0, () => {});
    assert.equal(app.minerProc, null, "dead miner handle cleared on a non-respawn close");
  });

  it("defers a restart with backoff (not synchronous) while under the failure cap (#6)", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-backoff-")) });
    app.logger = silentLogger();
    app.currPoolSocket = {};
    app.isWantMinerKill = false;
    app.lastMinerStartTime = Date.now();
    let spawned = 0;
    app.startMinerProcess = () => { spawned += 1; return { pid: 1 }; };
    app.handleMinerProcessClose("xmrig", 1, () => {});
    assert.ok(app.minerRestartTimer, "a backoff restart timer was scheduled");
    assert.equal(spawned, 0, "restart is deferred, not synchronous (no fork/exec storm)");
    clearTimeout(app.minerRestartTimer); // cleanup so the deferred restart can't fire later
  });

  it("pauses miner auto-restart after the consecutive-failure cap (#6)", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-cap-")) });
    app.logger = silentLogger();
    app.currPoolSocket = {};
    app.isWantMinerKill = false;
    app.lastMinerStartTime = Date.now(); // recent -> failures accumulate (no reset)
    app.startMinerProcess = () => ({ pid: 1 });
    app.minerRestartFailures = 5;        // = MINER_RESTART_MAX
    app.handleMinerProcessClose("xmrig", 1, () => {}); // 6th failure -> over cap
    assert.equal(app.minerRestartTimer, null, "no restart scheduled once over the failure cap");
    assert.ok(app.minerRestartFailures > 5, "failure was counted");
  });
});
