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
  it("logs only bounded socket error codes and preserves cleanup", () => {
    const cases = [
      { code: "ECONNRESET", suffix: ": ECONNRESET" },
      { code: "PRIVATE\\nINJECTED", suffix: "" },
      { code: "A".repeat(65), suffix: "" },
      { code: "invalid", suffix: "" },
      { code: {}, suffix: "" },
      { code: undefined, suffix: "" },
    ];
    for (const { code, suffix } of cases) {
      const messages = [];
      const server = new MinerServer({
        config: { miner_host: "127.0.0.1", miner_port: 0 },
        logger: { err(message) { messages.push(message); }, log() {} },
        flags: {},
        getPoolSocket: () => null,
      });
      const socket = makeMockSocket();
      server.handleConnection(socket);
      server.setCurrent(socket);
      socket.emit("error", Object.assign(new Error("PRIVATE MESSAGE"), { code }));
      assert.deepEqual(messages, [`Miner socket error${ suffix }`]);
      assert.equal(socket.destroyed, true);
      assert.equal(server.socket, null);
    }
  });

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

  it("does not let an old socket close a replacement connection", () => {
    const server = new MinerServer({
      config: { miner_host: "127.0.0.1", miner_port: 0 },
      logger: { err() {}, log() {} },
      flags: {},
      getPoolSocket: () => null,
    });
    const oldSocket = makeMockSocket();
    const replacement = makeMockSocket();
    server.handleConnection(oldSocket);
    server.setCurrent(oldSocket, "old-protocol");
    server.setCurrent(replacement, "new-protocol");

    oldSocket.emit("end");
    assert.equal(server.socket, replacement);
    assert.equal(server.protocol, "new-protocol");

    oldSocket.emit("error", new Error("late old socket error"));
    assert.equal(server.socket, replacement);
    assert.equal(server.protocol, "new-protocol");
  });

  it("clears the current connection when its own socket closes", () => {
    const server = new MinerServer({
      config: { miner_host: "127.0.0.1", miner_port: 0 },
      logger: { err() {}, log() {} },
      flags: {},
      getPoolSocket: () => null,
    });
    const current = makeMockSocket();
    server.handleConnection(current);
    server.setCurrent(current, "current-protocol");

    current.emit("end");
    assert.equal(server.socket, null);
    assert.equal(server.protocol, "default");
  });
});
