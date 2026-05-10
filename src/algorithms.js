"use strict";

const DEFAULT_ALGO = "rx/0";

const BENCH_ALGOS = [
  "cn/r",
  "cn-lite/1",
  "cn-heavy/xhv",
  "cn-pico/trtl",
  "cn/ccx",
  "cn/gpu",
  "argon2/chukwa",
  "kawpow",
  "ghostrider",
  "astrobwt",
  "rx/0",
  "rx/graft",
  "rx/arq",
  "panthera",
  "autolykos2",
  "c29",
  "c29b",
  "c29s",
  "c29v",
  "ethash",
  "etchash",
  "k12",
];

const CURRENT_GPU_ALGOS = ["autolykos2", "c29", "cn/gpu", "etchash", "kawpow"];

const BENCH_DEPS = {
  "cn/ccx": { "cn/ccx": 1, "cn/0": 0.5 },
  "cn/r": {
    "cn/1": 1,
    "cn/2": 1,
    "cn/r": 1,
    "cn/rto": 1,
    "cn/xao": 1,
    "cn/fast": 2,
    "cn/half": 2,
    "cn/rwz": 4 / 3,
    "cn/zls": 4 / 3,
    "cn/double": 0.5,
  },
  "cn-lite/1": { "cn-lite/0": 1, "cn-lite/1": 1 },
  "cn-heavy/xhv": { "cn-heavy/xhv": 1 },
  "cn-pico/trtl": { "cn-pico/trtl": 1 },
  "cn/gpu": { "cn/gpu": 1 },
  "argon2/chukwa": { "argon2/chukwa": 1 },
  "astrobwt": { astrobwt: 1 },
  kawpow: { kawpow: 1 },
  "rx/0": { "rx/0": 1, "rx/sfx": 1 },
  "rx/graft": { "rx/graft": 1 },
  "rx/arq": { "rx/arq": 1 },
  panthera: { panthera: 1 },
  autolykos2: { autolykos2: 1 },
  c29: { c29: 1 },
  c29b: { c29b: 1 },
  c29s: { c29s: 1 },
  c29v: { c29v: 1 },
  ethash: { ethash: 1 },
  etchash: { etchash: 1 },
  k12: { k12: 1 },
  ghostrider: { ghostrider: 1 },
};

function algoHashrateFactor(algo) {
  switch (algo) {
    case "kawpow":
      return 1 / 0x100000000;
    case "c29":
      return 1 / 42;
    case "c29s":
      return 1 / 32;
    case "c29b":
      return 1 / 40;
    case "c29v":
      return 1 / 16;
    default:
      return 1;
  }
}

function benchAlgoDeps(benchAlgo, perf) {
  const deps = BENCH_DEPS[benchAlgo];
  if (!deps) return {};
  const result = {};
  for (const [algo, factor] of Object.entries(deps)) result[algo] = perf * factor;
  return result;
}

function knownPerfAlgos() {
  const algos = new Set(BENCH_ALGOS);
  for (const deps of Object.values(BENCH_DEPS)) {
    for (const algo of Object.keys(deps)) algos.add(algo);
  }
  return algos;
}

function isKnownPerfAlgo(algo) {
  return knownPerfAlgos().has(algo);
}

function expandAlgoPerf(config, algo, perf) {
  const deps = benchAlgoDeps(algo, perf);
  if (Object.keys(deps).length === 0) {
    config.algo_perf[algo] = perf;
    return [algo];
  }
  for (const [depAlgo, depPerf] of Object.entries(deps)) config.algo_perf[depAlgo] = depPerf;
  return Object.keys(deps);
}

function algoAliases(algo) {
  const aliases = new Set([algo]);
  aliases.add(algo.replace("cryptonight", "cn"));
  aliases.add(algo.replace("randomx", "rx"));
  return Array.from(aliases);
}

function normalizePoolAlgo(algo, job) {
  if (algo === "cuckaroo") {
    const proofsize = job && typeof job === "object" ? Number(job.proofsize) : 0;
    if (proofsize === 42 || !proofsize) return "c29";
  }
  if (algo === "cuckaroo29") return "c29";
  return algo;
}

function assignAlgoCommand(config, algo, command) {
  for (const alias of algoAliases(algo)) config.algos[alias] = command;
}

module.exports = {
  BENCH_ALGOS,
  CURRENT_GPU_ALGOS,
  DEFAULT_ALGO,
  algoAliases,
  algoHashrateFactor,
  assignAlgoCommand,
  benchAlgoDeps,
  expandAlgoPerf,
  isKnownPerfAlgo,
  normalizePoolAlgo,
};
