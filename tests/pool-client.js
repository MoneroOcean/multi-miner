"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");

const { poolLoginParams } = require("../src/pool-client");

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
});
