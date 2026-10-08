"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const { createDefaultConfig } = require("../src/config");
const { runBenchmarkRuns } = require("../src/benchmark");
const { formatDiagnostics, validateConfig } = require("../src/diagnostics");
const { detectMinerProtocol, ethProxySubmit, ethProxyWork, ethSubscribeResult, isEthProxyWorkResult } = require("../src/protocol");
const { MultiMinerApp } = require("../mm");
const { ethNotifyParams, silentLogger } = require("./common/helpers");

function benchmarkFixture(t, algo, login) {
  const config = { algos: { [algo]: "fixture" }, algo_perf: {} };
  const child = new EventEmitter();
  // An already-exited fixture must drain its close event without signalling a PID.
  child.exitCode = 0;
  child.signalCode = null;
  const lines = [];
  const fixture = { config, child, completed: false };
  const server = {
    setHandlers(handlers) { fixture.handlers = handlers; },
    write(socket, line) { lines.push(line); },
  };
  t.after(() => child.emit("close", 0));
  runBenchmarkRuns({
    config,
    server,
    logger: silentLogger(),
    printMessages() {},
    startMiner(command, output) { fixture.output = output; return child; },
    timeoutMs: 1000,
    isStopping: () => false,
  }, () => { fixture.completed = true; });
  fixture.handlers.login(login, {});
  fixture.handlers.firstJob(login, {});
  fixture.protocol = server.protocol;
  fixture.line = lines.at(-1);
  fixture.reply = JSON.parse(fixture.line);
  return fixture;
}

describe("benchmark protocol jobs", () => {
  it("gives JSON-login C29 miners native Cuckaroo work and stabilizes three reports", (t) => {
    const fixture = benchmarkFixture(t, "c29", { id: 1, method: "login", params: {} });
    assert.equal(fixture.protocol, "default");
    const job = fixture.reply.result.job;
    assert.equal(job.algo, "cuckaroo");
    assert.match(job.blob, /^[0-9a-f]{64}$/);
    assert.match(job.target, /^[0-9a-f]{16}$/);
    assert.equal(job.target, "0100000000000000");
    assert.equal(job.proofsize, 42);
    assert.equal(job.noncebytes, 8);
    assert.equal(job.nonceoffset, 0);
    assert.equal(Object.hasOwn(job, "seed_hash"), false);
    assert.equal(fixture.reply.id, 1);
    assert.equal(fixture.line.indexOf('"id":1') < fixture.line.indexOf('"result"'), true);

    for (let report = 0; report < 3; report++) {
      fixture.output("| smry | 0/0/0 |     | --  | --  | --      | 42.0 H/s | Mining |\n");
      assert.equal(Object.hasOwn(fixture.config.algo_perf, "c29"), report === 2);
      assert.equal(fixture.completed, false, "completion must await child output closure");
    }
    assert.equal(fixture.config.algo_perf.c29, 1);
    fixture.child.emit("close", 0);
    assert.equal(fixture.completed, true);
  });

  for (const [algo, login, protocol, expectedHash] of [
    ["cn/gpu", { id: 1, method: "login", params: {} }, "default", "fd6b617ef774feff9e461e5c622ac93a0c68f1a52090f30788b1d56a0b4c8231"],
    ["c29", { id: "Stratum", method: "login", params: {} }, "grin", "2fb0385f58c150e85f55295929872d06910110a9eb9d24e128d3b1167934655e"],
  ]) {
    it(`preserves the ${algo} ${protocol} benchmark response byte-for-byte`, (t) => {
      const fixture = benchmarkFixture(t, algo, login);
      assert.equal(fixture.protocol, protocol);
      assert.equal(crypto.createHash("sha256").update(fixture.line).digest("hex"), expectedHash);
    });
  }
});

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

  it("scales the ethproxy boundary by the eth-stratum 2^32 factor (#7)", () => {
    const work = ethProxyWork(ethNotifyParams(), { jsonrpc: "2.0", method: "mining.set_difficulty", params: [2] });
    const boundary = BigInt(work[2]);
    const scale = 1000000n;
    const scaled = BigInt(Math.floor(2 * Number(scale)));
    const expected = ((1n << 256n) * scale) / (scaled << 32n); // 2^256/(d*2^32)
    assert.equal(boundary, expected, "boundary must be 2^256/(d*2^32), not the 2^32-too-loose 2^256/d");
    assert.ok(boundary < (1n << 256n) / 2n, "scaled boundary is far below the old unscaled value");
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
    const minerSocket = jsonSink(minerWrites);
    app.currPoolSocket = jsonSink(poolWrites);
    app.minerServer.setCurrent(minerSocket, "ethproxy");

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "eth_getWork", params: [] }, minerSocket);
    const header = minerWrites[0].result[0];
    app.currPoolLastJob = ethNotifyParams("job2");
    app.handleEthProxySubmit({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", header, "0x11"] }, minerSocket);

    assert.equal(poolWrites.length, 1);
    assert.equal(poolWrites[0].method, "mining.submit");
    assert.equal(poolWrites[0].params[1], "job1");
  });

  it("round-trips standard ETH submits with distinct upstream IDs and one ACK each", () => {
    const app = ethProxyApp("mm-eth-submit-roundtrip-");
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const firstParams = ["wallet", "eth-job-1", "0xnonce-1", "0xmix-1"];
    const secondParams = ["wallet", "eth-job-2", "0xnonce-2", "0xmix-2"];
    const firstSubmit = { id: 7, jsonrpc: "2.0", method: "mining.submit", params: firstParams };
    const secondSubmit = { id: 7, jsonrpc: "2.0", method: "mining.submit", params: secondParams };
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.minerServer.setCurrent(minerSocket, "eth");

    app.minerServer.handleMessage(firstSubmit, minerSocket);
    app.minerServer.handleMessage(secondSubmit, minerSocket);

    assert.equal(poolWrites.length, 2);
    assert.equal(typeof poolWrites[0].id, "number");
    assert.equal(typeof poolWrites[1].id, "number");
    assert.notEqual(poolWrites[0].id, poolWrites[1].id, "reused child IDs get distinct upstream IDs");
    assert.deepEqual(poolWrites[0].params, firstParams);
    assert.deepEqual(poolWrites[1].params, secondParams);
    assert.deepEqual(firstSubmit.params, firstParams);
    assert.deepEqual(secondSubmit.params, secondParams);

    const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: true };
    app.poolNewMsg(accepted);
    assert.deepEqual(minerWrites, [{ id: 7, jsonrpc: "2.0", error: null, result: true }]);
    app.poolNewMsg(accepted);
    assert.equal(minerWrites.length, 1, "a consumed pool ACK cannot produce a second child ACK");
    assert.deepEqual(accepted, { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: true });

    const error = { code: -1, message: "stale share", data: { share: "second" } };
    const rejected = { id: poolWrites[1].id, jsonrpc: "2.0", error };
    app.poolNewMsg(rejected);
    assert.deepEqual(minerWrites, [
      { id: 7, jsonrpc: "2.0", error: null, result: true },
      { id: 7, jsonrpc: "2.0", error },
    ]);
    assert.deepEqual(rejected, { id: poolWrites[1].id, jsonrpc: "2.0", error });
  });

  it("resets the upstream session and clears each child dialect on primary pool handover", () => {
    for (const protocol of ["eth", "ethproxy", "default", "grin"]) {
      const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), `mm-pool-handover-${  protocol  }-`)) });
      app.logger = silentLogger();
      const oldPoolSocket = trackedSocket();
      const newPoolSocket = trackedSocket();
      const oldMinerSocket = trackedSocket();
      const minerProcess = { pid: 4321 };
      const staleJob = ethNotifyParams(`stale-${  protocol  }`);
      const staleTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [2] };
      const staleExtraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["stale-prefix", 4] };
      app.config.algos = { etchash: "shared-etchash-child" };
      app.currPoolSocket = oldPoolSocket;
      app.currPoolLastJob = staleJob;
      app.currPoolMinerId = "stale-pool-miner";
      app.currPoolLastTarget = staleTarget;
      app.currPoolJobAlgo = "etchash";
      app.currPoolLoginResult = { id: "stale-pool-miner", status: "OK" };
      app.currPoolTargetAlgo = "etchash";
      app.currPoolTargetPending = true;
      app.currPoolLastExtraNonce = staleExtraNonce;
      app.currPoolExtraNonceAlgo = "etchash";
      app.currPoolExtraNoncePending = true;
      app.currMinerSupportsMoNative = true;
      app.currMinerBooleanSubmit = true;
      app.pendingMinerRequests.set(91, { socket: oldMinerSocket });
      app.pendingMinerFirstJob = { json: { id: 92 }, socket: oldMinerSocket };
      app.ethProxyWork.remember(staleJob, ["stale-header", "stale-seed", "stale-target"]);
      app.pendingEthFirstJob = { json: { id: 93 }, socket: oldMinerSocket };
      app.pendingEthSubscribeId = 94;
      app.delayNextEthFirstJob = true;
      app.currMiner = "shared-etchash-child";
      app.currAlgo = "etchash";
      app.minerProc = minerProcess;
      app.minerServer.setCurrent(oldMinerSocket, protocol);
      const staleTimer = setTimeout(() => {}, 60_000);
      app.pendingEthFirstJobTimer = staleTimer;

      try {
        app.poolOk(0, newPoolSocket);

        assert.equal(oldPoolSocket.destroyed, true, `${  protocol  } old pool socket must be closed`);
        assert.equal(oldMinerSocket.destroyed, true, `${  protocol  } child socket must be closed`);
        assert.equal(app.minerServer.socket, null, `${  protocol  } child socket must be cleared`);
        assert.equal(app.currPoolSocket, newPoolSocket);
        assert.equal(app.currPoolLastJob, null);
        assert.equal(app.currPoolMinerId, null);
        assert.equal(app.currPoolLastTarget, null);
        assert.equal(app.currPoolJobAlgo, null);
        assert.equal(app.currPoolLoginResult, null);
        assert.equal(app.currPoolTargetAlgo, null);
        assert.equal(app.currPoolTargetPending, false);
        assert.equal(app.currPoolLastExtraNonce, null);
        assert.equal(app.currPoolExtraNonceAlgo, null);
        assert.equal(app.currPoolExtraNoncePending, false);
        assert.equal(app.currMinerSupportsMoNative, false);
        assert.equal(app.currMinerBooleanSubmit, false);
        assert.equal(app.pendingMinerRequests.size, 0);
        assert.equal(app.pendingMinerFirstJob, null);
        assert.equal(app.pendingEthFirstJob, null);
        assert.equal(app.pendingEthSubscribeId, null);
        assert.equal(app.pendingEthFirstJobTimer, null);
        assert.equal(app.delayNextEthFirstJob, false);
        assert.equal(app.ethProxyWork.getJob({ params: ["nonce", "stale-header"] }), null);
        assert.equal(app.currMiner, "shared-etchash-child");
        assert.equal(app.currAlgo, "etchash");
        assert.equal(app.minerProc, minerProcess);
      } finally {
        clearTimeout(staleTimer);
        if (app.pendingEthFirstJobTimer) clearTimeout(app.pendingEthFirstJobTimer);
      }
    }
  });

  it("does not forward a new pool login reply to the old child on primary handover", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-pool-handover-login-")) });
    app.logger = silentLogger();
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    const oldPoolSocket = trackedSocket();
    const newPoolSocket = trackedSocket();
    const oldMinerSocket = trackedSocket();
    app.currPoolSocket = oldPoolSocket;
    app.minerServer.setCurrent(oldMinerSocket, "eth");

    app.poolOk(0, newPoolSocket);
    app.poolNewMsg({
      id: 1,
      jsonrpc: "2.0",
      error: null,
      result: { id: "fresh-pool-miner", algo: "etchash", extra_nonce: "fresh-prefix", extensions: [] },
    });

    assert.equal(oldMinerSocket.writes.length, 0, "the new pool login ACK must not reach the old child");
    assert.equal(app.minerServer.socket, null);
    assert.equal(app.currPoolLastJob, null, "a login ACK without a job must not resurrect stale work");
  });

  it("frames a fresh ETH child after handover and ignores a late old-socket end", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-pool-handover-eth-")) });
    app.logger = silentLogger();
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.replaceMiner = () => {};
    const oldPoolSocket = trackedSocket();
    const oldMinerSocket = trackedSocket();
    app.currPoolSocket = oldPoolSocket;
    app.minerServer.setCurrent(oldMinerSocket, "eth");
    const poolWrites = [];
    const newPoolSocket = jsonSink(poolWrites);
    app.poolOk(0, newPoolSocket);
    app.setRuntimeMinerHandlers();

    const newMinerWrites = [];
    const newMinerSocket = trackedSocket(newMinerWrites);
    const subscribe = { id: 1, jsonrpc: "2.0", method: "mining.subscribe", params: ["Rigel"] };
    const authorize = { id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["worker", "x"] };
    app.minerServer.handleMessage(subscribe, newMinerSocket);
    app.minerServer.handleMessage(authorize, newMinerSocket);
    assert.equal(poolWrites.length, 1);
    assert.equal(poolWrites[0].method, "mining.subscribe");

    const subscribeResult = ethSubscribeResult("fresh");
    app.poolNewMsg({ id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: subscribeResult });
    const freshJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("fresh-job") };
    app.poolNewMsg(freshJob);
    app.minerServer.handleClose("late-old-end", oldMinerSocket);

    assert.equal(app.minerServer.socket, newMinerSocket);
    assert.deepEqual(newMinerWrites, [
      { jsonrpc: "2.0", id: 2, error: null, result: true },
      { id: 1, jsonrpc: "2.0", error: null, result: subscribeResult.slice(0, 2) },
      freshJob,
    ]);
  });

  it("recognizes accepted untagged Pearl job variants, including a cached login job", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-pearl-job-shape-")) });
    app.logger = silentLogger();
    const header = "ab".repeat(76);
    const jobs = [
      { cert_version: 3, header, job_id: "pearl-string" },
      { cert_version: 3, header: `0x${  header}`, job_id: 7 },
    ];

    for (const job of jobs) {
      app.currPoolJobAlgo = null;
      assert.equal(app.recordPoolMessage({ jsonrpc: "2.0", method: "mining.notify", params: job }), "pearlhash");
    }

    app.currPoolJobAlgo = null;
    assert.equal(app.recordPoolMessage({
      id: 1,
      jsonrpc: "2.0",
      error: null,
      result: { id: "pool-worker", job: jobs[1], status: "OK" },
    }), "pearlhash");
  });

  it("does not inherit Pearl for an untagged legacy job", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-pearl-legacy-job-")) });
    app.logger = silentLogger();
    app.currPoolJobAlgo = "pearlhash";
    const params = ["legacy-job", "header", "target"];

    assert.equal(app.recordPoolMessage({ jsonrpc: "2.0", method: "mining.notify", params }), "rx/0");
    assert.equal(app.currPoolJobAlgo, "rx/0");
    assert.deepEqual(app.currPoolLastJob, params);
  });

  it("holds a Pearl job until the child subscribe reply and sends it once", async () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-pearl-subscribe-")) });
    app.logger = silentLogger();
    app.config.algos = { pearlhash: "pearl-child" };
    app.currMiner = "pearl-child";
    app.currAlgo = "pearlhash";
    app.currPoolJobAlgo = "pearlhash";
    app.currPoolLastJob = { cert_version: 3, header: "00".repeat(76), job_id: "old-job" };
    app.replaceMiner = () => {};
    const poolWrites = [];
    const minerWrites = [];
    const poolSocket = jsonSink(poolWrites);
    const minerSocket = trackedSocket(minerWrites);
    app.currPoolSocket = poolSocket;
    app.setRuntimeMinerHandlers();

    app.minerServer.handleMessage({ id: 1, jsonrpc: "2.0", method: "mining.subscribe", params: [] }, minerSocket);
    app.minerServer.handleMessage({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: ["wallet", "x"] }, minerSocket);
    const freshJob = {
      id: null,
      jsonrpc: "2.0",
      method: "mining.notify",
      params: { cert_version: 3, header: "11".repeat(76), job_id: "fresh-job" },
    };
    app.poolNewMsg(freshJob, poolSocket);
    assert.deepEqual(minerWrites, [{ id: 2, jsonrpc: "2.0", error: null, result: true }]);

    app.poolNewMsg({ id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: ethSubscribeResult("pearl") }, poolSocket);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(minerWrites.filter((message) => message.method === "mining.notify").length, 1);
    assert.equal(minerWrites.at(-1).params.job_id, "fresh-job");
  });

  it("ignores a late frame from a replaced pool socket", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-stale-pool-frame-")) });
    app.logger = silentLogger();
    const currentPool = trackedSocket();
    app.currPoolSocket = currentPool;
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = ethNotifyParams("current-job");

    app.poolNewMsg({
      jsonrpc: "2.0",
      method: "mining.notify",
      params: { cert_version: 3, header: "22".repeat(76), job_id: "stale-pearl" },
    }, trackedSocket());

    assert.equal(app.currPoolJobAlgo, "etchash");
    assert.deepEqual(app.currPoolLastJob, ethNotifyParams("current-job"));
  });

  it("preserves an optional final hash on translated ETH proxy submits", () => {
    const submit = ethProxySubmit({ id: 3, params: ["0x00", "0xheader", "0xmix"], result: "a".repeat(64) }, "wallet", ["job1"]);
    assert.equal(submit.result, "a".repeat(64));
    assert.deepEqual(submit.params, ["wallet", "job1", "0x00", "0xheader", "0xmix"]);
  });

  it("round-trips ETH proxy submits with original IDs and optional final hashes", () => {
    const app = ethProxyApp("mm-ethproxy-submit-roundtrip-");
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.minerServer.setCurrent(minerSocket, "ethproxy");

    app.sendFirstJob({ id: 5, jsonrpc: "2.0", method: "eth_getWork", params: [] }, minerSocket);
    const work = minerWrites[0].result;
    minerWrites.length = 0;

    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const firstSubmit = {
      id: 9,
      jsonrpc: "2.0",
      method: "eth_submitWork",
      params: ["0xnonce-1", work[0], "0xmix-1"],
      result: firstHash,
    };
    const secondSubmit = {
      id: 9,
      jsonrpc: "2.0",
      method: "eth_submitWork",
      params: ["0xnonce-2", work[0], "0xmix-2"],
      result: secondHash,
    };
    app.minerServer.handleMessage(firstSubmit, minerSocket);
    app.minerServer.handleMessage(secondSubmit, minerSocket);

    assert.equal(poolWrites.length, 2);
    assert.equal(typeof poolWrites[0].id, "number");
    assert.equal(typeof poolWrites[1].id, "number");
    assert.notEqual(poolWrites[0].id, poolWrites[1].id, "successive proxy submits get distinct upstream IDs");
    assert.deepEqual(poolWrites[0].params, ["wallet", "job1", "0xnonce-1", work[0], "0xmix-1"]);
    assert.deepEqual(poolWrites[1].params, ["wallet", "job1", "0xnonce-2", work[0], "0xmix-2"]);
    assert.equal(poolWrites[0].result, firstHash, "the first optional final hash reaches the pool");
    assert.equal(poolWrites[1].result, secondHash, "the second optional final hash reaches the pool");
    assert.deepEqual(firstSubmit.params, ["0xnonce-1", work[0], "0xmix-1"]);
    assert.equal(firstSubmit.result, firstHash);
    assert.deepEqual(secondSubmit.params, ["0xnonce-2", work[0], "0xmix-2"]);
    assert.equal(secondSubmit.result, secondHash);

    const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: true };
    app.poolNewMsg(accepted);
    assert.deepEqual(minerWrites, [{ id: 9, jsonrpc: "2.0", error: null, result: true }]);
    app.poolNewMsg(accepted);
    assert.equal(minerWrites.length, 1, "a consumed proxy ACK cannot produce a second child ACK");
    assert.deepEqual(accepted, { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: true });

    const error = { code: -1, message: "stale proxy share", data: { share: "second" } };
    const rejected = { id: poolWrites[1].id, jsonrpc: "2.0", error };
    app.poolNewMsg(rejected);
    assert.deepEqual(minerWrites, [
      { id: 9, jsonrpc: "2.0", error: null, result: true },
      { id: 9, jsonrpc: "2.0", error },
    ]);
    assert.deepEqual(rejected, { id: poolWrites[1].id, jsonrpc: "2.0", error });
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

  it("keeps object login RPC IDs before the full cached result", () => {
    const app = ethProxyApp("mm-object-metadata-");
    const minerWrites = [];
    app.minerServer.protocol = "default";
    app.currPoolLoginResult = {
      id: "pool-miner",
      status: "OK",
      extensions: ["mo-native"],
      algo: "rx/0",
      extra_nonce: "abcd",
      extra_nonce2_size: 4,
      metadata: { retained: true },
    };
    app.currPoolLastJob = { algo: "rx/0", blob: "00", job_id: "job1", target: "ffffffff" };

    app.currPoolMinerId = "current-pool-miner";
    const original = structuredClone(app.currPoolLoginResult);
    const job = structuredClone(app.currPoolLastJob);
    const requests = [0, 2, "rpc-id", null, undefined].map(id => ({ id, method: "login" }));
    requests.push({ method: "login" }, Object.assign(Object.create({ id: "inherited-id" }), { method: "login" }));
    for (const request of requests) {
      app.sendFirstJob(request, jsonSink(minerWrites));
      const reply = minerWrites.at(-1);
      assert.deepStrictEqual(Object.keys(reply), request.id === undefined
        ? ["jsonrpc", "error", "result"] : ["jsonrpc", "id", "error", "result"]);
      const expected = { jsonrpc: "2.0", error: null, result: {
        ...original, id: app.currPoolMinerId, job, status: "OK",
      } };
      if (request.id !== undefined) expected.id = request.id;
      assert.deepStrictEqual(reply, expected);
      assert.deepStrictEqual(app.currPoolLoginResult, original);
      assert.deepStrictEqual(app.currPoolLastJob, job);
    }
  });

  it("uses current native nonce metadata and keeps the array job inside notify", () => {
    const app = ethProxyApp("mm-native-object-login-");
    const minerWrites = [];
    app.minerServer.protocol = "default";
    app.currPoolMinerId = "pool-miner";
    app.currAlgo = "kawpow";
    app.currPoolJobAlgo = "kawpow";
    app.currPoolLoginResult = {
      id: "pool-miner",
      extensions: ["mo-native"],
      extra_nonce: "old-prefix",
      extra_nonce2_size: 4,
    };
    app.currPoolLastExtraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["new-prefix", 5] };
    app.currPoolExtraNonceAlgo = "kawpow";
    app.currPoolLastTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [2] };
    app.currPoolLastJob = ethNotifyParams("kawpow-job");

    app.sendFirstJob({ id: 2, method: "login", params: { extensions: ["mo-native"] } }, jsonSink(minerWrites));

    assert.equal(minerWrites[0].result.id, "pool-miner");
    assert.equal(minerWrites[0].result.algo, "kawpow");
    assert.equal(minerWrites[0].result.extra_nonce, "new-prefix");
    assert.equal(minerWrites[0].result.extra_nonce2_size, 5);
    assert.deepEqual(minerWrites[0].result.extensions, ["mo-native"]);
    assert.equal("job" in minerWrites[0].result, false);
    assert.deepEqual(minerWrites[1].params, ["new-prefix", 5]);
    assert.equal(minerWrites[1].algo, "kawpow");
    assert.deepEqual(app.currPoolLastExtraNonce.params, ["new-prefix", 5]);
    assert.equal(minerWrites[2].method, "mining.set_difficulty");
    assert.equal(minerWrites[2].algo, "kawpow");
    assert.deepEqual(minerWrites[3].params, app.currPoolLastJob);
    assert.equal(minerWrites[3].algo, "kawpow");
  });

  it("retains an Ergo target for native-object children but filters it for standard ETH", () => {
    const target = { jsonrpc: "2.0", method: "mining.set_target", params: ["0x1234"] };
    const nativeApp = ethProxyApp("mm-native-ergo-target-");
    const nativeWrites = [];
    nativeApp.minerServer.protocol = "default";
    nativeApp.currMinerSupportsMoNative = true;
    nativeApp.currAlgo = "autolykos2";
    nativeApp.currPoolJobAlgo = "autolykos2";
    nativeApp.currPoolLastTarget = target;
    nativeApp.currPoolLastJob = ethNotifyParams("ergo-job");

    nativeApp.sendFirstJob({ id: 2, method: "login", params: { extensions: ["mo-native"] } }, jsonSink(nativeWrites));

    assert.equal(nativeWrites[1].method, "mining.set_target");
    assert.equal(nativeWrites[1].algo, "autolykos2");
    assert.deepEqual(target, { jsonrpc: "2.0", method: "mining.set_target", params: ["0x1234"] });

    const ethApp = ethProxyApp("mm-eth-ergo-target-");
    const ethWrites = [];
    ethApp.minerServer.protocol = "eth";
    ethApp.currAlgo = "autolykos2";
    ethApp.currPoolJobAlgo = "autolykos2";
    ethApp.currPoolLastTarget = target;
    ethApp.currPoolLastJob = ethNotifyParams("ergo-job");

    ethApp.sendFirstJob({ id: 2, method: "mining.authorize" }, jsonSink(ethWrites));

    assert.equal(ethWrites.length, 1);
    assert.equal(ethWrites[0].method, "mining.notify");
  });

  it("rejects a native array job for an object child without mo-native", () => {
    const app = ethProxyApp("mm-native-object-legacy-");
    const minerWrites = [];
    app.minerServer.protocol = "default";
    app.currAlgo = "kawpow";
    app.currPoolJobAlgo = "kawpow";
    app.currPoolLastJob = ethNotifyParams("kawpow-job");

    app.sendFirstJob({ id: 2, method: "login", params: {} }, jsonSink(minerWrites));

    assert.equal(minerWrites.length, 1);
    assert.equal(minerWrites[0].id, 2);
    assert.match(minerWrites[0].error, /mo-native/);
  });

  it("filters a native pool job from an already connected legacy object child", () => {
    const app = ethProxyApp("mm-native-object-switch-");
    const minerWrites = [];
    app.minerServer.protocol = "default";
    app.minerServer.socket = jsonSink(minerWrites);
    app.currMiner = "miner --kawpow";
    app.config.algos = { kawpow: app.currMiner };
    app.currMinerSupportsMoNative = false;

    app.poolNewMsg({ jsonrpc: "2.0", method: "mining.notify", algo: "kawpow", params: ethNotifyParams("kawpow-job") });

    assert.equal(minerWrites.length, 0);
  });

  it("keeps an unmarked target pending for the next family job", () => {
    const app = ethProxyApp("mm-target-pending-");
    const target = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [2] };
    app.currPoolJobAlgo = "rx/0";
    app.currPoolTargetAlgo = "rx/0";
    app.currPoolLastTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", algo: "rx/0", params: [1] };
    app.recordPoolMessage(target);
    app.recordPoolMessage({ jsonrpc: "2.0", method: "mining.notify", algo: "kawpow", params: ethNotifyParams("kawpow-job") });

    assert.equal(app.currPoolLastTarget, target);
    assert.equal(app.currPoolTargetAlgo, "kawpow");
    assert.equal(app.currPoolTargetPending, false);
  });

  it("drops a marked target when the following job belongs to another family", () => {
    const app = ethProxyApp("mm-target-family-");
    const target = { jsonrpc: "2.0", method: "mining.set_difficulty", algo: "rx/0", params: [1] };
    app.currPoolJobAlgo = "rx/0";
    app.recordPoolMessage(target);
    app.recordPoolMessage({ jsonrpc: "2.0", method: "mining.notify", algo: "kawpow", params: ethNotifyParams("kawpow-job") });

    assert.equal(app.currPoolLastTarget, null);
  });

  it("defers unmarked ETH controls until a new Etchash job replaces cached work", () => {
    const app = ethProxyApp("mm-first-job-unmarked-eth-");
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const oldJob = ethNotifyParams("old-etchash-job");
    const extraNonce = {
      jsonrpc: "2.0",
      method: "mining.set_extranonce",
      params: ["next-prefix", 4],
    };
    const target = {
      jsonrpc: "2.0",
      method: "mining.set_difficulty",
      params: [2],
    };
    app.minerServer.protocol = "eth";
    app.minerServer.setCurrent(minerSocket, "eth");
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = oldJob;

    app.poolNewMsg(extraNonce);
    app.poolNewMsg(target);
    assert.deepEqual(minerWrites, []);
    assert.equal(app.currPoolExtraNoncePending, true);
    assert.equal(app.currPoolTargetPending, true);
    app.sendFirstJob({ id: 30, jsonrpc: "2.0", method: "mining.authorize", params: ["worker", "x"] }, minerSocket);
    assert.deepEqual(minerWrites, [], "cached work is not sent with unbound controls");
    assert.equal(app.pendingMinerFirstJob.socket, minerSocket);

    const newJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("new-etchash-job") };
    app.poolNewMsg(newJob);

    assert.deepEqual(minerWrites, [
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["next-prefix"] },
      target,
      newJob,
    ]);
    assert.equal(minerWrites.filter((message) => message.method === "mining.notify").length, 1);
    assert.equal(minerWrites.some((message) => message.params === oldJob), false);
    assert.deepEqual(extraNonce, {
      jsonrpc: "2.0",
      method: "mining.set_extranonce",
      params: ["next-prefix", 4],
    });
    assert.deepEqual(target, { jsonrpc: "2.0", method: "mining.set_difficulty", params: [2] });
  });

  it("defers a replacement ETH login job until a same-family notify", () => {
    const app = ethProxyApp("mm-first-job-replacement-eth-");
    const oldWrites = [];
    const newWrites = [];
    const oldSocket = jsonSink(oldWrites);
    const newSocket = jsonSink(newWrites);
    app.setRuntimeMinerHandlers();
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = ethNotifyParams("old-etchash-job");
    app.minerServer.setCurrent(oldSocket, "eth");

    const extraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["replacement-prefix", 5] };
    const target = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [3] };
    app.poolNewMsg(extraNonce);
    app.poolNewMsg(target);
    app.minerServer.handleMessage({ id: 40, jsonrpc: "2.0", method: "mining.authorize", params: ["old", "x"] }, oldSocket);
    assert.deepEqual(oldWrites, [{ jsonrpc: "2.0", id: 40, error: null, result: true }]);
    oldWrites.length = 0;

    app.minerServer.handleClose("closed", oldSocket);
    app.minerServer.handleMessage({ id: 41, jsonrpc: "2.0", method: "mining.authorize", params: ["new", "x"] }, newSocket);
    assert.deepEqual(newWrites, [{ jsonrpc: "2.0", id: 41, error: null, result: true }],
      "replacement login receives only its login response before the next job");
    newWrites.length = 0;

    const newJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("replacement-etchash-job") };
    app.poolNewMsg(newJob);
    assert.deepEqual(newWrites, [
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["replacement-prefix"] },
      target,
      newJob,
    ]);
    assert.equal(newWrites.filter((message) => message.method === "mining.notify").length, 1);
  });

  it("defers a replacement native login job until a same-family notify", () => {
    const app = ethProxyApp("mm-first-job-replacement-native-");
    const oldWrites = [];
    const newWrites = [];
    const oldSocket = jsonSink(oldWrites);
    const newSocket = jsonSink(newWrites);
    const oldJob = ethNotifyParams("old-native-etchash-job");
    const extraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["native-prefix", 4] };
    const target = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [4] };
    app.logger = silentLogger();
    app.minerServer.logger = silentLogger();
    app.setRuntimeMinerHandlers();
    app.minerServer.protocol = "default";
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolMinerId = "pool-native-miner";
    app.currPoolLoginResult = { id: "pool-native-miner", status: "OK" };
    app.currPoolLastJob = oldJob;
    app.minerServer.setCurrent(oldSocket, "default");
    app.poolNewMsg(extraNonce);
    app.poolNewMsg(target);

    app.minerServer.handleMessage({
      id: 50,
      jsonrpc: "2.0",
      method: "login",
      params: { login: "old", pass: "x", extensions: ["mo-native"] },
    }, oldSocket);
    assert.deepEqual(oldWrites, [], "native replacement does not receive cached controls or a cached job");
    app.minerServer.handleClose("closed", oldSocket);

    app.minerServer.handleMessage({
      id: 51,
      jsonrpc: "2.0",
      method: "login",
      params: { login: "new", pass: "x", extensions: ["mo-native"] },
    }, newSocket);
    assert.deepEqual(newWrites, [], "native replacement login is held until a fresh notify");

    const newJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("new-native-etchash-job") };
    app.poolNewMsg(newJob);
    assert.deepEqual(newWrites, [
      {
        jsonrpc: "2.0",
        id: 51,
        error: null,
        result: {
          id: "pool-native-miner",
          algo: "etchash",
          extensions: ["mo-native"],
          status: "OK",
          extra_nonce: "native-prefix",
          extra_nonce2_size: 4,
        },
      },
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["native-prefix", 4] },
      { jsonrpc: "2.0", method: "mining.set_difficulty", algo: "etchash", params: [4] },
      { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: newJob.params },
    ]);
    assert.equal(newWrites.filter((message) => message.method === "mining.notify").length, 1);
  });

  it("does not deliver a queued first job from a stale child socket", () => {
    const app = ethProxyApp("mm-first-job-stale-socket-");
    const oldWrites = [];
    const newWrites = [];
    const oldSocket = jsonSink(oldWrites);
    const newSocket = jsonSink(newWrites);
    const extraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["stale-prefix", 4] };
    app.minerServer.protocol = "eth";
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = ethNotifyParams("old-stale-job");
    app.minerServer.setCurrent(oldSocket, "eth");
    app.poolNewMsg(extraNonce);
    app.sendFirstJob({ id: 60, jsonrpc: "2.0", method: "mining.authorize", params: ["old", "x"] }, oldSocket);
    assert.deepEqual(oldWrites, []);

    app.minerServer.setCurrent(newSocket, "eth");
    app.minerServer.handleClose("closed", oldSocket);
    assert.equal(app.minerServer.socket, newSocket);
    const newJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("new-stale-job") };
    app.poolNewMsg(newJob);

    assert.equal(newWrites.some((message) => message.id === 60), false, "the old first-job request is not replayed to the new socket");
    assert.deepEqual(newWrites, [
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["stale-prefix"] },
      newJob,
    ]);
  });

  it("does not pair a marked next-family control with cached old work", () => {
    const app = ethProxyApp("mm-first-job-marked-family-");
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const nextTarget = {
      jsonrpc: "2.0",
      method: "mining.set_difficulty",
      algo: "kawpow",
      params: [9],
    };
    app.minerServer.protocol = "eth";
    app.minerServer.setCurrent(minerSocket, "eth");
    app.config.algos = { etchash: "shared-etchash-child", kawpow: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = ethNotifyParams("old-marked-job");

    app.poolNewMsg(nextTarget);
    assert.deepEqual(minerWrites, []);
    app.sendFirstJob({ id: 70, jsonrpc: "2.0", method: "mining.authorize", params: ["worker", "x"] }, minerSocket);
    assert.deepEqual(minerWrites, [], "a marked next-family target does not accompany the cached job");

    const newJob = { jsonrpc: "2.0", method: "mining.notify", algo: "kawpow", params: ethNotifyParams("new-marked-job") };
    app.poolNewMsg(newJob);
    assert.deepEqual(minerWrites, [nextTarget, newJob]);
    assert.equal(minerWrites.filter((message) => message.method === "mining.notify").length, 1);
    assert.equal(app.currPoolLastTarget, nextTarget, "the marked control is retained for its matching new family job");
  });

  it("defers ETH proxy getWork until pending difficulty binds to a new job", () => {
    const app = ethProxyApp("mm-first-job-ethproxy-");
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const oldJob = ethNotifyParams("old-proxy-job");
    oldJob[2] = "old-proxy-header";
    const nextTarget = { jsonrpc: "2.0", method: "mining.set_difficulty", params: [7] };
    app.minerServer.protocol = "ethproxy";
    app.minerServer.setCurrent(minerSocket, "ethproxy");
    app.config.algos = { etchash: "shared-etchash-child" };
    app.currMiner = "shared-etchash-child";
    app.currAlgo = "etchash";
    app.currPoolJobAlgo = "etchash";
    app.currPoolLastJob = oldJob;
    app.setRuntimeMinerHandlers();
    app.poolNewMsg(nextTarget);

    const getWork = { id: 80, jsonrpc: "2.0", method: "eth_getWork", params: [] };
    app.minerServer.handleMessage(getWork, minerSocket);
    assert.deepEqual(minerWrites, [], "pending difficulty cannot be paired with the cached header");
    assert.equal(app.pendingMinerFirstJob.socket, minerSocket);

    const newJob = ethNotifyParams("new-proxy-job");
    newJob[2] = "new-proxy-header";
    app.poolNewMsg({ jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: newJob });

    const expectedWork = ethProxyWork(newJob, nextTarget);
    assert.deepEqual(minerWrites, [{ jsonrpc: "2.0", id: 80, error: null, result: expectedWork }]);
    assert.equal(minerWrites[0].result[0], "0xnew-proxy-header");
    assert.notEqual(minerWrites[0].result[0], ethProxyWork(oldJob, nextTarget)[0]);
    assert.equal(app.pendingMinerFirstJob, null);
  });

  it("replays a cached nonce prefix before the first native notify", () => {
    const app = ethProxyApp("mm-native-prefix-");
    const minerWrites = [];
    app.minerServer.protocol = "eth";
    app.currAlgo = "kawpow";
    app.currPoolLastTarget = null;
    app.currPoolLastExtraNonce = { jsonrpc: "2.0", method: "mining.set_extranonce", params: ["abcd", 4] };
    app.currPoolLastJob = ethNotifyParams("kawpow-job");

    app.sendFirstJob({ id: 2, method: "mining.authorize" }, jsonSink(minerWrites));

    assert.equal(minerWrites[0].method, "mining.set_extranonce");
    assert.equal(minerWrites[0].algo, "kawpow");
    assert.equal(minerWrites[1].method, "mining.notify");
  });

  it("strips explicit nonce widths from cached ETH controls without mutating metadata", () => {
    for (const algo of ["kawpow", "etchash"]) {
      const app = ethProxyApp(`mm-eth-cached-nonce-${  algo  }-`);
      const minerWrites = [];
      const extraNonce = {
        jsonrpc: "2.0",
        method: "mining.set_extranonce",
        params: [`${  algo  }-prefix`, 4],
      };
      app.minerServer.protocol = "eth";
      app.currAlgo = algo;
      app.currPoolJobAlgo = algo;
      app.currPoolLastTarget = null;
      app.currPoolLastExtraNonce = extraNonce;
      app.currPoolLastJob = ethNotifyParams(`${  algo  }-job`);

      app.sendFirstJob({ id: 2, method: "mining.authorize" }, jsonSink(minerWrites));

      assert.deepEqual(minerWrites[0].params, [`${  algo  }-prefix`]);
      assert.equal(minerWrites[0].algo, algo);
      assert.deepEqual(extraNonce, {
        jsonrpc: "2.0",
        method: "mining.set_extranonce",
        params: [`${  algo  }-prefix`, 4],
      });
    }
  });

  it("strips explicit nonce widths from pushed ETH controls without mutating pool messages", () => {
    for (const algo of ["kawpow", "etchash"]) {
      const app = ethProxyApp(`mm-eth-pushed-nonce-${  algo  }-`);
      const minerWrites = [];
      const control = {
        jsonrpc: "2.0",
        method: "mining.set_extranonce",
        algo,
        params: [`${  algo  }-prefix`, 4],
      };
      app.minerServer.protocol = "eth";
      app.minerServer.socket = jsonSink(minerWrites);
      app.currAlgo = algo;
      app.currPoolJobAlgo = algo;

      app.poolNewMsg(control);

      assert.deepEqual(minerWrites, [{
        jsonrpc: "2.0",
        method: "mining.set_extranonce",
        algo,
        params: [`${  algo  }-prefix`],
      }]);
      assert.deepEqual(control, {
        jsonrpc: "2.0",
        method: "mining.set_extranonce",
        algo,
        params: [`${  algo  }-prefix`, 4],
      });
    }
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
    app.poolNewMsg({ id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: [["mining.notify", "live", "EthereumStratum/1.0.0"], "ff00", 6] });
    app.flushPendingEthFirstJob();

    assert.equal(poolWrites[0].method, "mining.subscribe");
    assert.equal(minerWrites[1].id, 1);
    assert.deepEqual(minerWrites[2], { jsonrpc: "2.0", method: "job", params: app.currPoolLastJob });
  });

  it("trims only matched Etchash subscribe metadata", () => {
    for (const [algo, fieldCount] of [["etchash", 2], ["kawpow", 3], ["autolykos2", 3]]) {
      const app = ethProxyApp(`mm-eth-subscribe-${  algo  }-`);
      const minerWrites = [];
      const poolWrites = [];
      const socket = jsonSink(minerWrites);
      const subscribe = { id: `${  algo  }-subscribe`, jsonrpc: "2.0", method: "mining.subscribe", params: [] };
      const result = ethSubscribeResult("live");
      app.minerServer.protocol = "eth";
      app.currAlgo = algo;
      app.currPoolJobAlgo = algo;
      app.currPoolSocket = jsonSink(poolWrites);

      app.handleMinerSubscribe(subscribe, socket);
      const reply = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result };
      app.poolNewMsg(reply);

      assert.deepEqual(minerWrites[0].result, result.slice(0, fieldCount));
      assert.deepEqual(reply.result, result);
    }
  });

  it("does not forward marked next-family controls to the old ETH child", () => {
    const app = ethProxyApp("mm-switch-marked-controls-");
    const oldChildWrites = [];
    const replacements = [];
    app.minerServer.protocol = "eth";
    app.minerServer.socket = jsonSink(oldChildWrites);
    app.config.algos = {
      kawpow: "old-kawpow-child",
      etchash: "new-etchash-child",
    };
    app.currAlgo = "kawpow";
    app.currPoolJobAlgo = "kawpow";
    app.currMiner = "old-kawpow-child";
    app.replaceMiner = (command) => replacements.push(command);

    const nextExtraNonce = {
      jsonrpc: "2.0",
      method: "mining.set_extranonce",
      algo: "etchash",
      params: ["next-prefix", 4],
    };
    const nextTarget = {
      jsonrpc: "2.0",
      method: "mining.set_difficulty",
      algo: "etchash",
      params: [2],
    };
    app.poolNewMsg(nextExtraNonce);
    app.poolNewMsg(nextTarget);

    assert.deepEqual(oldChildWrites, []);
    const nextJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("etchash-job") };
    app.poolNewMsg(nextJob);

    assert.deepEqual(replacements, ["new-etchash-child"]);
    assert.equal(app.minerServer.socket, null);
    assert.deepEqual(app.currPoolLastExtraNonce, nextExtraNonce);
    assert.deepEqual(app.currPoolLastTarget, nextTarget);
  });

  it("replays compatible controls before a same-child job and clears an old-family control", () => {
    const app = ethProxyApp("mm-switch-same-child-");
    const childWrites = [];
    const sharedChild = "shared-eth-child";
    app.minerServer.protocol = "eth";
    app.minerServer.socket = jsonSink(childWrites);
    app.config.algos = { kawpow: sharedChild, etchash: sharedChild };
    app.currAlgo = "kawpow";
    app.currPoolJobAlgo = "kawpow";
    app.currMiner = sharedChild;
    app.currPoolLastTarget = {
      jsonrpc: "2.0",
      method: "mining.set_difficulty",
      algo: "kawpow",
      params: [1],
    };
    app.currPoolTargetAlgo = "kawpow";
    app.currPoolTargetPending = false;

    const nextExtraNonce = {
      jsonrpc: "2.0",
      method: "mining.set_extranonce",
      algo: "etchash",
      params: ["next-prefix", 4],
    };
    app.poolNewMsg(nextExtraNonce);
    assert.deepEqual(childWrites, []);

    const nextJob = { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("etchash-job") };
    app.poolNewMsg(nextJob);

    assert.deepEqual(childWrites, [
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["next-prefix"] },
      nextJob,
    ]);
    assert.equal(app.minerServer.socket !== null, true);
    assert.equal(app.currPoolLastTarget, null);
  });

  it("gives a replacement ETH child fresh controls before its first job", () => {
    const app = ethProxyApp("mm-switch-new-child-");
    const oldChildWrites = [];
    const newChildWrites = [];
    const replacements = [];
    app.minerServer.protocol = "eth";
    app.minerServer.socket = jsonSink(oldChildWrites);
    app.config.algos = {
      kawpow: "old-kawpow-child",
      etchash: "new-etchash-child",
    };
    app.currAlgo = "kawpow";
    app.currPoolJobAlgo = "kawpow";
    app.currMiner = "old-kawpow-child";
    app.replaceMiner = (command) => replacements.push(command);

    const nextExtraNonce = {
      jsonrpc: "2.0",
      method: "mining.set_extranonce",
      algo: "etchash",
      params: ["fresh-prefix", 5],
    };
    const nextTarget = {
      jsonrpc: "2.0",
      method: "mining.set_difficulty",
      algo: "etchash",
      params: [3],
    };
    app.poolNewMsg(nextExtraNonce);
    app.poolNewMsg(nextTarget);
    app.poolNewMsg({ jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams("fresh-job") });

    assert.deepEqual(oldChildWrites, []);
    assert.deepEqual(replacements, ["new-etchash-child"]);
    assert.equal(app.minerServer.socket, null);

    app.setRuntimeMinerHandlers();
    const authorize = { id: 41, jsonrpc: "2.0", method: "mining.authorize", params: ["worker", "x"] };
    app.minerServer.handleMessage(authorize, jsonSink(newChildWrites));

    assert.deepEqual(newChildWrites, [
      { jsonrpc: "2.0", id: 41, error: null, result: true },
      { jsonrpc: "2.0", method: "mining.set_extranonce", algo: "etchash", params: ["fresh-prefix"] },
      nextTarget,
      { jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: app.currPoolLastJob },
    ]);
  });

  it("correlates legacy C29 submits and adapts only object OK replies", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-c29-submit-correlation-")) });
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const job = c29ObjectJob();
    const loginResult = {
      id: "pool-miner",
      status: "OK",
      job,
      extra_nonce: "c29-prefix",
      extra_nonce2_size: 4,
      metadata: { source: "pool" },
    };
    app.logger = silentLogger();
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.currAlgo = "c29";
    app.currPoolJobAlgo = "c29";
    app.currPoolMinerId = "pool-miner";
    app.currPoolLastJob = job;
    app.currPoolLoginResult = loginResult;
    app.currMinerSupportsMoNative = false;

    app.minerServer.handleMessage({ id: 11, jsonrpc: "2.0", method: "login", params: { login: "worker", pass: "x" } }, minerSocket);

    assert.deepEqual(minerWrites[0].result, loginResult, "legacy C29 login/job metadata remains an object");
    assert.deepEqual(job, c29ObjectJob(), "login job metadata is unchanged after local login handling");

    const submit = c29Submit(11, job.job_id);
    app.minerServer.handleMessage(submit, minerSocket);
    assert.equal(typeof poolWrites[0].id, "number", "legacy submit gets an upstream numeric ID");
    assert.notEqual(poolWrites[0].id, submit.id, "upstream ID differs from the child ID");

    const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: { status: "OK" } };
    app.poolNewMsg(accepted);
    assert.deepEqual(minerWrites[1], { id: submit.id, jsonrpc: "2.0", error: null, result: true });
    assert.deepEqual(accepted.result, { status: "OK" }, "pool object reply is not mutated");

    const rejectedSubmit = c29Submit(12, job.job_id);
    app.minerServer.handleMessage(rejectedSubmit, minerSocket);
    const rejected = {
      id: poolWrites[1].id,
      jsonrpc: "2.0",
      error: { code: -1, message: "rejected" },
    };
    app.poolNewMsg(rejected);
    assert.deepEqual(minerWrites[2], { id: rejectedSubmit.id, jsonrpc: "2.0", error: rejected.error });
  });

  it("keeps C29 object OK replies for advertised capabilities but converts plain-login replies", () => {
    for (const [label, params, expectedResult] of [
      ["algo", { login: "worker", pass: "x", algo: ["c29"] }, { status: "OK" }],
      ["algo-perf", { login: "worker", pass: "x", "algo-perf": { c29: 1 } }, { status: "OK" }],
      ["plain", { login: "worker", pass: "x" }, true],
    ]) {
      const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), `mm-c29-submit-${  label  }-`)) });
      const poolWrites = [];
      const minerWrites = [];
      const minerSocket = jsonSink(minerWrites);
      const job = c29ObjectJob(`${  label  }-job`);
      app.logger = silentLogger();
      app.setRuntimeMinerHandlers();
      app.currPoolSocket = jsonSink(poolWrites);
      app.currAlgo = "c29";
      app.currPoolJobAlgo = "c29";
      app.currPoolMinerId = "pool-miner";
      app.currPoolLastJob = job;
      app.currPoolLoginResult = { id: "pool-miner", status: "OK", job, metadata: { source: "pool" } };
      app.currMinerSupportsMoNative = false;

      app.minerServer.handleMessage({ id: 51, jsonrpc: "2.0", method: "login", params }, minerSocket);
      assert.equal(minerWrites.length, 1);
      minerWrites.length = 0;

      const submit = c29Submit(61, job.job_id);
      app.minerServer.handleMessage(submit, minerSocket);
      const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: { status: "OK" } };
      app.poolNewMsg(accepted);

      assert.deepEqual(minerWrites, [{ id: submit.id, jsonrpc: "2.0", error: null, result: expectedResult }]);
    }
  });

  it("keeps object OK replies for mo-native C29 children", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-c29-submit-native-")) });
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    const job = c29ObjectJob("c29-native-job");
    app.logger = silentLogger();
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.currAlgo = "c29";
    app.currPoolJobAlgo = "c29";
    app.currPoolMinerId = "pool-miner";
    app.currPoolLastJob = job;
    app.currPoolLoginResult = { id: "pool-miner", status: "OK", job, metadata: { source: "pool" } };

    app.minerServer.handleMessage({
      id: 20,
      jsonrpc: "2.0",
      method: "login",
      params: { login: "worker", pass: "x", extensions: ["mo-native"] },
    }, minerSocket);
    assert.equal(minerWrites.length, 1);
    assert.equal(minerWrites[0].result.status, "OK");
    minerWrites.length = 0;

    const submit = c29Submit(21, job.job_id);
    app.minerServer.handleMessage(submit, minerSocket);
    const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: { status: "OK" } };
    app.poolNewMsg(accepted);

    assert.deepEqual(minerWrites, [{ id: submit.id, jsonrpc: "2.0", error: null, result: { status: "OK" } }]);
  });

  it("does not deliver a late legacy C29 ACK to a replacement child reusing its ID", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-c29-submit-late-")) });
    const poolWrites = [];
    const oldWrites = [];
    const newWrites = [];
    const oldSocket = jsonSink(oldWrites);
    const newSocket = jsonSink(newWrites);
    app.logger = silentLogger();
    app.minerServer.logger = silentLogger();
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.currAlgo = "c29";
    app.currPoolJobAlgo = "c29";
    app.currMinerSupportsMoNative = false;
    app.minerServer.handleMessage({ id: 1, jsonrpc: "2.0", method: "login", params: { login: "old", pass: "x" } }, oldSocket);

    const oldSubmit = c29Submit(31, "c29-old-job");
    app.minerServer.handleMessage(oldSubmit, oldSocket);
    app.minerServer.handleClose("closed", oldSocket);
    app.minerServer.handleMessage({ id: 2, jsonrpc: "2.0", method: "login", params: { login: "new", pass: "x" } }, newSocket);
    const newSubmit = c29Submit(31, "c29-new-job");
    app.minerServer.handleMessage(newSubmit, newSocket);
    app.minerServer.handleClose("closed", oldSocket);

    assert.equal(typeof poolWrites[0].id, "number");
    assert.equal(typeof poolWrites[1].id, "number");
    assert.notEqual(poolWrites[0].id, poolWrites[1].id, "reused child IDs receive distinct upstream IDs");
    assert.equal(app.minerServer.socket, newSocket, "a stale close from the old child does not clear the replacement");
    assert.deepEqual(oldWrites, []);
    assert.deepEqual(newWrites, []);

    app.poolNewMsg({ id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: { status: "OK" } });
    assert.deepEqual(newWrites, [], "late old-child ACK is not delivered to the replacement");

    app.poolNewMsg({ id: poolWrites[1].id, jsonrpc: "2.0", error: null, result: { status: "OK" } });
    assert.deepEqual(newWrites, [{ id: newSubmit.id, jsonrpc: "2.0", error: null, result: true }]);
  });

  it("keeps Grin submit acknowledgments as submit/ok replies", () => {
    const app = new MultiMinerApp([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-grin-submit-")) });
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    app.logger = silentLogger();
    app.setRuntimeMinerHandlers();
    app.currPoolSocket = jsonSink(poolWrites);
    app.currAlgo = "c29";
    app.currPoolJobAlgo = "c29";
    const job = c29ObjectJob("c29-grin-job");
    app.currPoolMinerId = "pool-miner";
    app.currPoolLastJob = job;
    app.currPoolLoginResult = { id: "pool-miner", status: "OK", job };

    app.minerServer.handleMessage({
      id: "Stratum",
      jsonrpc: "2.0",
      method: "login",
      params: { algorithm: "cuckarood29", login: "worker", pass: "x" },
    }, minerSocket);
    assert.deepEqual(minerWrites, [{ jsonrpc: "2.0", method: "login", result: "ok" }]);
    minerWrites.length = 0;

    const submit = { id: "Stratum", jsonrpc: "2.0", method: "submit", params: { job_id: job.job_id, nonce: 1 } };
    app.minerServer.handleMessage(submit, minerSocket);
    const accepted = { id: poolWrites[0].id, jsonrpc: "2.0", error: null, result: { status: "OK" } };
    app.poolNewMsg(accepted);

    assert.deepEqual(minerWrites, [{ id: submit.id, jsonrpc: "2.0", error: null, method: "submit", result: "ok" }]);
  });

  it("maps ETH proxy submits to pushed work headers", () => {
    const app = ethProxyApp("mm-ethproxy-push-");
    const poolWrites = [];
    const minerWrites = [];
    const minerSocket = jsonSink(minerWrites);
    app.currPoolSocket = jsonSink(poolWrites);
    app.minerServer.setCurrent(minerSocket, "ethproxy");

    app.sendFirstJob({ id: 2, jsonrpc: "2.0", method: "eth_getWork", params: [] }, minerSocket);
    app.currPoolLastJob = ethNotifyParams("job2");
    app.poolNewMsg({ id: 0, jsonrpc: "2.0", result: ["0xpushheader", "0xseed", "0xtarget"], algo: "etchash" });
    app.handleEthProxySubmit({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", "0xpushheader", "0x11"] }, minerSocket);

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

function c29ObjectJob(jobId) {
  return {
    algo: "cuckaroo",
    blob: "c29-blob",
    height: 1,
    job_id: jobId || "c29-job",
    noncebytes: 8,
    nonceoffset: 0,
    proofsize: 42,
    target: "ffffffff",
  };
}

function c29Submit(id, jobId) {
  return {
    id,
    jsonrpc: "2.0",
    method: "submit",
    params: { id: "worker", job_id: jobId, nonce: "00", result: "00" },
  };
}

function jsonSink(target) { return { write: (line) => target.push(JSON.parse(line)) }; }

function trackedSocket(writes) {
  const socket = {
    destroyed: false,
    ended: false,
    writes: writes || [],
    write(line) { socket.writes.push(typeof line === "string" ? JSON.parse(line) : line); },
    destroy() { socket.destroyed = true; },
    end() { socket.ended = true; },
  };
  return socket;
}
