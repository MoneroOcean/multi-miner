"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");

const net = require("net");
const { connectPool, poolLoginParams } = require("../src/pool-client");

describe("pool client", () => {
  it("advertises newly measured raw KawPow performance as kawpow1", () => {
    const params = poolLoginParams({
      user: "wallet",
      pass: "x",
      algo_min_time: 60,
      algos: { kawpow: "miner", "rx/0": "miner" },
      algo_perf: { kawpow1: 20882200, "rx/0": 1000 },
    }, "multi-miner/test");

    assert.deepEqual(params.algo, ["kawpow1", "rx/0"]);
    assert.equal(params["algo-perf"].kawpow1, 20882200);
    assert.equal("kawpow" in params["algo-perf"], false);
  });

  it("preserves legacy saved KawPow performance and capability names", () => {
    const params = poolLoginParams({
      user: "wallet",
      pass: "x",
      algo_min_time: 60,
      algos: { kawpow: "miner" },
      algo_perf: { kawpow: 0.01 },
    }, "multi-miner/test");

    assert.deepEqual(params.algo, ["kawpow"]);
    assert.equal(params["algo-perf"].kawpow, 0.01);
    assert.equal("kawpow1" in params["algo-perf"], false);
  });

  it("fails over exactly once when the pool gracefully closes after login", async () => {
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", result: { status: "OK" }, error: null })  }\n`);
        socket.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    let okCount = 0;
    let errCount = 0;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("onError was not called: no failover on graceful post-login FIN")), 3000);
        connectPool({
          agent: "multi-miner/test",
          config: { pools: [`127.0.0.1:${  port}`], user: "wallet", pass: "x", algo_min_time: 60, algos: { "rx/0": "miner" }, algo_perf: { "rx/0": 1000 } },
          debug: false,
          logger: null,
          poolNum: 0,
          verbose: false,
          onOk: () => { okCount += 1; },
          onMessage: () => {},
          onError: () => {
            errCount += 1;
            setTimeout(() => { clearTimeout(timer); resolve(); }, 50).unref();
          },
        });
      });
      assert.equal(okCount, 1, "login confirmed once");
      assert.equal(errCount, 1, "failover fired exactly once");
    } finally {
      server.close();
    }
  });
});
