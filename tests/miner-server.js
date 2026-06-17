"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { describe, it } = require("node:test");

const { MinerServer } = require("../src/miner-server");

function makeMockSocket() {
  const socket = new EventEmitter();
  socket.remoteAddress = "127.0.0.1";
  socket.end = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = () => {};
  return socket;
}

describe("miner server", () => {
  it("attaches an error listener to a rejected duplicate connection so it cannot crash the process", () => {
    const server = new MinerServer({
      config: { miner_host: "127.0.0.1", miner_port: 0 },
      logger: { err() {}, log() {} },
      flags: {},
    });
    // Simulate an already-connected miner so the next connection is rejected.
    server.socket = makeMockSocket();

    const rejected = makeMockSocket();
    server.handleConnection(rejected);

    // Before the fix the rejected socket had no 'error' listener, so this emit was
    // rethrown by EventEmitter and terminated the process.
    assert.doesNotThrow(() => {
      rejected.emit("error", Object.assign(new Error("RST after end"), { code: "ECONNRESET" }));
    });
    assert.equal(rejected.destroyed, true, "rejected socket is destroyed on error");
  });
});
