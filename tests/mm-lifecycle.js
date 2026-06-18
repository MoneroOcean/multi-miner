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
});
