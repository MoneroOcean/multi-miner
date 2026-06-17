"use strict";

const { BENCH_ALGOS, benchAlgoDeps, hasAlgoPerf } = require("./algorithms");
const { forEachHashrate } = require("./hashrate");
const { benchmarkSubscribeReply } = require("./miner-server");
const { detectMinerProtocol, ethProxyWork, grinJsonReply, jsonReply } = require("./protocol");
const { stringifyLine } = require("./json-lines");
const { treeKill } = require("./process-manager");

function runBenchmarkRuns(options, callback) {
  const queue = [];
  for (const algo of BENCH_ALGOS) {
    if (hasAlgoPerf(options.config, algo) || !(algo in options.config.algos)) continue;
    queue.push((resolve) => runOneBenchmark(options, algo, resolve));
  }

  function next() {
    const task = queue.shift();
    if (!task) {
      callback();
      return;
    }
    task(next);
  }
  next();
}

function runOneBenchmark(options, algo, resolve) {
  options.logger.log(`Checking miner performance for ${  algo  } algo`);
  const cmd = options.config.algos[algo];
  let minerProc = null;
  let completed = false;
  let printsNeeded = -1;
  let printsFound = 0;
  let parserIndex = -1;

  const timeout = setTimeout(() => {
    if (completed) return;
    options.logger.err(`Can't find performance data in '${  cmd  }' miner output`);
    finish();
  }, options.timeoutMs || 5 * 60 * 1000);

  function finish() {
    completed = true;
    clearTimeout(timeout);
    if (!minerProc) {
      resolve();
      return;
    }
    minerProc.once("close", resolve);
    treeKill(minerProc.pid);
  }

  options.server.setHandlers({
    login(json, minerSocket) {
      const protocol = detectMinerProtocol(json);
      options.server.protocol = protocol;
      if (protocol === "grin") options.server.write(minerSocket, grinJsonReply("login", "ok"));
      if (protocol === "eth") options.server.write(minerSocket, jsonReply(json, true));
    },
    firstJob(json, minerSocket) {
      options.server.write(minerSocket, benchmarkJobLine(algo, options.server.protocol, json));
    },
    subscribe(json, minerSocket) {
      options.server.write(minerSocket, benchmarkSubscribeReply(json, "benchmark"));
    },
  });

  minerProc = options.startMiner(cmd, (str) => {
    options.printMessages(str);
    forEachHashrate(str, algo, (hashrate, entry, idx) => {
      if (printsNeeded < 0) {
        printsNeeded = entry.stabilization;
        parserIndex = idx;
      }
      printsFound++;
      if (printsFound >= printsNeeded) {
        setBenchmarkPerf(options, algo, hashrate);
        finish();
        return false;
      }
      options.logger.log(`Read performance for ${  algo  } algo to ${  hashrate  }, waiting for ${  printsNeeded - printsFound  } more print(s).`);
      return true;
    }, () => parserIndex);
  });
}

function setBenchmarkPerf(options, algo, hashrate) {
  const deps = benchAlgoDeps(algo, hashrate);
  for (const [depAlgo, depHashrate] of Object.entries(deps)) {
    options.logger.log(`Setting performance for ${  depAlgo  } algo to ${  depHashrate}`);
    options.config.algo_perf[depAlgo] = depHashrate;
  }
}

function benchmarkJobLine(algo, protocol, json) {
  if (protocol === "grin") return grinBenchmarkJob(algo);
  if (protocol === "ethproxy") return stringifyLine({ jsonrpc: "2.0", id: json.id, error: null, result: ethProxyWork(ethBenchmarkParams(algo), null) });
  if (protocol === "eth") return ethBenchmarkJob(algo);
  return defaultBenchmarkJob(algo, json);
}

function grinBenchmarkJob(algo) {
  return stringifyLine({
    jsonrpc: "2.0",
    id: "Stratum",
    error: null,
    method: "getjobtemplate",
    result: {
      difficulty: 99999999,
      pre_pow: "0c0ccbc9035e0000000026c1674f64401b00e6c50b681f21bb5d5bb07be6d4a9d12a8cb2b493c9c039fee90877199a9dc04dccd734cf9b4b30eae84d06b94da19614536f3a87b0fe65f201",
      algo: "cuckaroo",
      edgebits: 29,
      proofsize: grinProofSize(algo),
      noncebytes: algo === "c29" ? 8 : 4,
      height: 0,
      job_id: "100000000000000",
      id: "100000000000000",
      status: "OK",
    },
  });
}

function grinProofSize(algo) {
  if (algo === "c29") return 42;
  if (algo === "c29s") return 32;
  if (algo === "c29b") return 40;
  return 48;
}

function ethBenchmarkJob(algo) {
  if (algo === "kawpow") {
    return stringifyLine({ jsonrpc: "2.0", method: "mining.notify", params: ethBenchmarkParams("kawpow") });
  }
  if (algo === "autolykos2") return autolykosJob();
  return ethashJob();
}

function ethashJob() {
  return stringifyLine({ jsonrpc: "2.0", method: "mining.set_difficulty", params: [1000000] }) +
    stringifyLine({
      jsonrpc: "2.0",
      method: "mining.notify",
      params: ethBenchmarkParams("etchash"),
    });
}

function ethBenchmarkParams(algo) {
  if (algo === "kawpow") {
    return [
      "benchmark1",
      "4c38e8a5f7b2944d1e4274635d828519b97bc64a1f1c7896ecdbb139988aa0e8",
      "accf7d1311da015b8dd41569c845c0ac739f0637707b8a117119fe1b5aeaa011",
      "000000000002bd75000000000000000000000000000000000000000000000000",
      true,
      1500000,
      "1b0290a7",
    ];
  }
  return [
    "benchmark1",
    "e79f0f63030bf691445c2b9d0266b24a9619e355194067f2ad2c73a8e0a26c65",
    "feb4243b885cd1af5337979f5d81849335cab197b4993e5c61ea4b43b43dbbc6",
    true,
  ];
}

function autolykosJob() {
  return stringifyLine({
    jsonrpc: "2.0",
    method: "mining.notify",
    params: [
      "benchmark1",
      539302,
      "920b5e8ed76f90e760469f04391ffaef3b5ecf1e1cb9363c449f490bc1564663",
      "",
      "",
      2,
      "82463468449557216163199121184281840485288878744226428810224501",
      "",
      true,
    ],
  });
}

function defaultBenchmarkJob(algo, json) {
  return stringifyLine({
    jsonrpc: "2.0",
    id: "id" in json ? json.id : 1,
    error: null,
    result: {
      id: "benchmark",
      status: "OK",
      job: {
        target: "01000000",
        blob: "7f7ffeeaa0db054f15eca39c843cb82c15e5c5a7743e06536cb541d4e96e90ffd31120b7703aa90000000076a6f6e34a9977c982629d8fe6c8b45024cafca109eef92198784891e0df41bc03",
        seed_hash: "0000000000000000000000000000000000000000000000000000000000000001",
        algo,
        height: 0,
        job_id: "benchmark1",
        id: "benchmark",
      },
    },
  });
}

module.exports = {
  runBenchmarkRuns,
};
