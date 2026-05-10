"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const { createDefaultConfig } = require("../src/config");
const { formatDiagnostics, validateConfig } = require("../src/diagnostics");
const { detectMinerProtocol, ethProxyWork, isEthProxyWorkResult } = require("../src/protocol");
const { MultiMinerApp } = require("../mm");
const { ethNotifyParams, silentLogger } = require("./common/helpers");

describe("protocol and diagnostics", () => {
  it("detects protocols without missing-field crashes", () => {
    assert.equal(detectMinerProtocol({ method: "login", params: {} }), "default");
    assert.equal(detectMinerProtocol({ method: "mining.authorize", params: [] }), "eth");
    assert.equal(detectMinerProtocol({ method: "eth_submitLogin", params: [] }), "ethproxy");
    assert.equal(detectMinerProtocol({ id: "Stratum", method: "login" }), "grin");
  });

  it("converts ethash notify payloads to ETH proxy work", () => {
    assert.deepEqual(ethProxyWork(ethNotifyParams(), null), [
      "0xfeb4243b885cd1af5337979f5d81849335cab197b4993e5c61ea4b43b43dbbc6",
      "0xe79f0f63030bf691445c2b9d0266b24a9619e355194067f2ad2c73a8e0a26c65",
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ]);
  });

  it("detects pushed ETH proxy work result frames", () => {
    assert.equal(isEthProxyWorkResult({ id: 0, jsonrpc: "2.0", result: ["0xaa", "0xbb", "0xcc"], algo: "etchash" }), true);
    assert.equal(isEthProxyWorkResult({ id: 0, jsonrpc: "2.0", result: ["0xaa", "0xbb", "0xcc", "0x123"], algo: "etchash" }), true);
    assert.equal(isEthProxyWorkResult({ method: "mining.notify", params: [] }), false);
  });

  it("maps ETH proxy submits to the polled work header", () => {
    const app = ethProxyApp("mm-ethproxy-");
    const poolWrites = [];
    const minerWrites = [];
    app.currPoolSocket = jsonSink(poolWrites);

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "eth_getWork", params: [] }, jsonSink(minerWrites));
    const header = minerWrites[0].result[0];
    app.currPoolLastJob = ethNotifyParams("job2");
    app.handleEthProxySubmit({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", header, "0x11"] }, { write() {} });

    assert.equal(poolWrites.length, 1);
    assert.equal(poolWrites[0].method, "mining.submit");
    assert.equal(poolWrites[0].params[1], "job1");
  });

  it("sends object jobs as standard job pushes for subscribe/authorize miners", () => {
    const app = ethProxyApp("mm-eth-standard-");
    const minerWrites = [];
    app.minerServer.protocol = "eth";
    app.currPoolLastJob = {
      algo: "ghostrider",
      blob: "00",
      job_id: "job1",
      target: "ffffffff",
    };

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["wallet", "x"] }, jsonSink(minerWrites));

    assert.deepEqual(minerWrites[0], { jsonrpc: "2.0", method: "job", params: app.currPoolLastJob });
  });

  it("sends cached autolykos difficulty before first notify", () => {
    const app = ethProxyApp("mm-autolykos-diff-");
    const minerWrites = [];
    app.minerServer.protocol = "eth";
    app.currAlgo = "autolykos2";
    app.currPoolLastTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [0.001] };
    app.currPoolLastJob = ethNotifyParams("job1");

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["wallet", "x"] }, jsonSink(minerWrites));

    assert.equal(minerWrites[0].method, "mining.set_difficulty");
    assert.equal(minerWrites[1].method, "mining.notify");
  });

  it("keeps subscribe replies before first jobs for pipelined subscribe/authorize miners", () => {
    const app = ethProxyApp("mm-eth-order-");
    const minerWrites = [];
    const poolWrites = [];
    const socket = jsonSink(minerWrites);
    app.currPoolSocket = jsonSink(poolWrites);
    app.currPoolLastJob = { algo: "ghostrider", blob: "00", job_id: "job1", target: "ffffffff" };

    app.handleMinerSubscribe({ id: 1, jsonrpc: "2.0", method: "mining.subscribe", params: ["XMRig"] }, socket);
    app.handleMinerLogin({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["wallet", "x"] }, socket);
    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["wallet", "x"] }, socket);

    assert.equal(minerWrites.length, 1);
    assert.equal(minerWrites[0].id, 2);
    app.poolNewMsg({ id: 1, jsonrpc: "2.0", error: null, result: [["mining.notify", "live", "EthereumStratum/1.0.0"], "ff00", 6] });
    app.flushPendingEthFirstJob();

    assert.equal(poolWrites[0].method, "mining.subscribe");
    assert.equal(minerWrites[1].id, 1);
    assert.deepEqual(minerWrites[2], { jsonrpc: "2.0", method: "job", params: app.currPoolLastJob });
  });

  it("maps ETH proxy submits to pushed work headers", () => {
    const app = ethProxyApp("mm-ethproxy-push-");
    const poolWrites = [];
    const minerWrites = [];
    app.currPoolSocket = jsonSink(poolWrites);
    app.minerServer.socket = jsonSink(minerWrites);

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "eth_getWork", params: [] }, jsonSink(minerWrites));
    app.currPoolLastJob = ethNotifyParams("job2");
    app.poolNewMsg({ id: 0, jsonrpc: "2.0", result: ["0xpushheader", "0xseed", "0xtarget"], algo: "etchash" });
    app.handleEthProxySubmit({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", "0xpushheader", "0x11"] }, { write() {} });

    assert.equal(minerWrites.length, 2);
    assert.deepEqual(minerWrites[1], { id: 0, jsonrpc: "2.0", result: ["0xpushheader", "0xseed", "0xtarget"], algo: "etchash" });
    assert.equal(poolWrites.length, 1);
    assert.equal(poolWrites[0].method, "mining.submit");
    assert.equal(poolWrites[0].params[1], "job2");
  });

  it("rejects unknown ETH proxy submit headers locally", () => {
    const app = ethProxyApp("mm-ethproxy-");
    const poolWrites = [];
    const minerWrites = [];
    app.currPoolSocket = jsonSink(poolWrites);

    app.handleEthProxySubmit({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", "0xdead", "0x11"] }, jsonSink(minerWrites));

    assert.equal(poolWrites.length, 0);
    assert.deepEqual(minerWrites[0], { jsonrpc: "2.0", id: 3, error: null, result: false });
  });

  it("reports config errors and warnings", () => {
    const config = createDefaultConfig();
    const result = validateConfig(config);
    assert.ok(result.errors.includes("You must specify at least one pool"));
    assert.match(formatDiagnostics(config), /Multi-Miner diagnostics/);
  });

  it("uses configured c29 miner for MoneroOcean cuckaroo jobs", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-c29-")) });
    app.config.algos = { c29: "miner --c29" };
    app.startMinerProcess = () => ({ pid: 0, on() {}, once() {} });
    app.poolNewMsg({
      id: 1,
      jsonrpc: "2.0",
      error: null,
      result: {
        id: "pool-miner",
        status: "OK",
        job: {
          algo: "cuckaroo",
          proofsize: 42,
          blob: "17b9ac16fe37c3e2f0bf8bb9fec6dae1f59a1f0ce1d40fdcfb33fab18b6ce28a",
          job_id: "c29-live",
        },
      },
    });
    assert.equal(app.currAlgo, "c29");
    assert.equal(app.currMiner, "miner --c29");
  });
});

function ethProxyApp(tmpPrefix) {
  const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix)) });
  app.logger = silentLogger();
  app.config.user = "wallet";
  app.minerServer.protocol = "ethproxy";
  app.currPoolLastTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [0.000001] };
  app.currPoolLastJob = ethNotifyParams("job1");
  return app;
}

function jsonSink(target) { return { write: (line) => target.push(JSON.parse(line)) }; }
