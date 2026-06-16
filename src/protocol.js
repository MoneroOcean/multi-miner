"use strict";

const { stringifyLine } = require("./json-lines");
const DEFAULT_ETH_PROXY_WORK_RETENTION = 64;

function jsonReply(json, result) {
  return stringifyLine({ jsonrpc: "2.0", id: json.id, error: null, result });
}

function jsonError(json, error) {
  return stringifyLine({ jsonrpc: "2.0", id: json.id, error });
}

function grinJsonReply(method, result) {
  return stringifyLine({ jsonrpc: "2.0", method, result });
}

function detectMinerProtocol(json) {
  if (String(json.method || "").startsWith("eth_")) return "ethproxy";
  if (json.method === "mining.authorize" || json.method === "mining.subscribe") return "eth";
  const params = json.params && typeof json.params === "object" ? json.params : {};
  if (json.id === "Stratum" || params.algorithm === "cuckarood29v") return "grin";
  return "default";
}

function ethSubscribeResult(tag) {
  return [[ "mining.notify", tag, "EthereumStratum/1.0.0" ], "ff00", 6];
}

function ethProxyWork(job, targetMessage) {
  const params = Array.isArray(job) ? job : [];
  if (typeof params[1] === "number" && params.length >= 7) {
    return [hex(params[2]), hex(params[6]), ethProxyTarget(targetMessage)];
  }
  return [
    hex(params[2]),
    hex(params[1]),
    ethProxyTarget(targetMessage),
  ];
}

function isEthProxyWorkResult(json) {
  return json && !("method" in json) && Array.isArray(json.result) && json.result.length >= 3 &&
    typeof json.result[0] === "string" && typeof json.result[1] === "string" && typeof json.result[2] === "string";
}

function ethProxySubmit(json, user, job) {
  const params = Array.isArray(json.params) ? json.params : [];
  const jobId = Array.isArray(job) && job[0] ? job[0] : "job";
  return {
    id: json.id,
    jsonrpc: "2.0",
    method: "mining.submit",
    params: [user || "", jobId, params[0] || "0x0", params[1] || "0x0", params[2] || "0x0"],
  };
}

function ethProxySubmitHeader(json) {
  const params = Array.isArray(json.params) ? json.params : [];
  return normalizeHex(params[1]);
}

function ethProxyWorkHeader(work) {
  return normalizeHex(Array.isArray(work) ? work[0] : "");
}

function createEthProxyWorkTracker(limit) {
  const jobsByHeader = new Map();
  const maxEntries = limit || DEFAULT_ETH_PROXY_WORK_RETENTION;
  return {
    clear() {
      jobsByHeader.clear();
    },
    remember(job, work) {
      const header = ethProxyWorkHeader(work);
      if (!header) return;
      jobsByHeader.set(header, clonePoolJob(job));
      while (jobsByHeader.size > maxEntries) jobsByHeader.delete(jobsByHeader.keys().next().value);
    },
    getJob(json) {
      const header = ethProxySubmitHeader(json);
      return header ? jobsByHeader.get(header) : null;
    },
  };
}

const MAX_ETH_PROXY_TARGET = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function ethProxyTarget(message) {
  if (message && message.method === "mining.set_target" && Array.isArray(message.params)) return hex(message.params[0]);
  if (message && message.method === "mining.set_difficulty" && Array.isArray(message.params)) return difficultyTarget(message.params[0]);
  return MAX_ETH_PROXY_TARGET;
}

function difficultyTarget(value) {
  const difficulty = Number(value);
  if (!Number.isFinite(difficulty) || difficulty <= 0) return MAX_ETH_PROXY_TARGET;
  const scale = 1000000n;
  const scaledDifficulty = BigInt(Math.max(1, Math.floor(difficulty * Number(scale))));
  const max = (1n << 256n) - 1n;
  const target = ((1n << 256n) * scale) / scaledDifficulty;
  return "0x" + (target > max ? max : target).toString(16).padStart(64, "0");
}

function hex(value) {
  if (typeof value !== "string" || value.length === 0) return "0x0";
  return value.startsWith("0x") ? value : "0x" + value;
}

function normalizeHex(value) {
  if (typeof value !== "string") return "";
  const normalized = value.toLowerCase();
  return normalized.startsWith("0x") ? normalized.slice(2) : normalized;
}

function clonePoolJob(job) {
  if (Array.isArray(job)) return job.slice();
  if (job && typeof job === "object") return Object.assign({}, job);
  return job;
}

module.exports = {
  createEthProxyWorkTracker,
  detectMinerProtocol,
  ethProxySubmit,
  ethProxyWork,
  ethSubscribeResult,
  isEthProxyWorkResult,
  grinJsonReply,
  jsonError,
  jsonReply,
};
