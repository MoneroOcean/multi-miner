"use strict";

const net = require("net");
const tls = require("tls");
const { createJsonLineParser, stringifyLine } = require("./json-lines");
const { parsePoolAddress } = require("./config");

function poolAlgoName(config, algo) {
  if (algo !== "kawpow") return algo;
  return config.algo_perf.kawpow1 ? "kawpow1" : "kawpow";
}

function poolLoginParams(config, agent) {
  const algos = Array.from(new Set(Object.keys(config.algos).map((algo) => poolAlgoName(config, algo))));
  const algoPerf = {};
  for (const [algo, perf] of Object.entries(config.algo_perf)) {
    if (algo === "kawpow" && config.algo_perf.kawpow1) continue;
    algoPerf[algo] = perf;
  }
  return {
    login: config.user,
    pass: config.pass,
    agent,
    algo: algos,
    "algo-perf": algoPerf,
    "algo-min-time": config.algo_min_time,
  };
}

function connectPool(options) {
  const config = options.config;
  const logger = options.logger;
  const poolNum = options.poolNum;
  const poolLabel = config.pools[poolNum];
  const parsed = parsePoolAddress(poolLabel);
  if (!parsed) {
    process.nextTick(() => options.onError(poolNum));
    return null;
  }

  const socket = parsed.tls
    ? tls.connect(parsed.port, parsed.host, { rejectUnauthorized: false })
    : net.connect(parsed.port, parsed.host);

  socket.on("connect", () => {
    writePoolSocket(socket, {
      id: 1,
      jsonrpc: "2.0",
      method: "login",
      params: poolLoginParams(config, options.agent),
    }, logger, options.debug);
  });

  let isPoolOk = false;
  const parser = createJsonLineParser((json) => {
    if (options.debug && logger) logger.log("Pool message: " + JSON.stringify(json));
    if (!isPoolOk && (json.error === null || typeof json.error === "undefined")) {
      options.onOk(poolNum, socket);
      isPoolOk = true;
    }
    if (isPoolOk) {
      if (isKeepaliveReply(json)) {
        if (options.verbose && logger) logger.log("Keepalive reply received from the pool");
      } else {
        options.onMessage(json);
      }
    } else if (logger) {
      logger.err("Ignoring pool (" + poolLabel + ") message since pool has not confirmed login yet: " + JSON.stringify(json));
    }
  }, (message) => {
    if (logger) logger.err("Can't parse message from the pool (" + poolLabel + "): " + message);
  });

  socket.on("data", (msg) => parser.push(msg));
  let notified = false;
  // Drive failover/reconnect exactly once when the pool connection ends. The "end" path previously
  // only acted before login; a graceful post-login FIN (pool restart/maintenance/idle) merely logged,
  // so mm.js was never told, the dead socket stayed as currPoolSocket, and the miner was silently
  // orphaned (no jobs, no reconnect). Route "end" and "error" through one guard so they cannot
  // double-fire. Deliberately NOT "close": it also fires on mm.js's own destroy during a pool switch,
  // which must not trigger failover.
  const failover = (reason) => {
    if (notified) return;
    notified = true;
    socket.destroy();
    if (logger) logger.err("Pool (" + poolLabel + ") " + reason);
    options.onError(poolNum);
  };
  socket.on("end", () => failover(isPoolOk ? "socket closed" : "socket closed before sending first job"));
  socket.on("error", () => failover("socket error"));
  return socket;
}

function writePoolSocket(socket, message, logger, debug) {
  const line = typeof message === "string" ? message : stringifyLine(message);
  if (debug && logger) logger.log("Multi-Miner message to pool: " + line.trimEnd());
  socket.write(line);
}

function isKeepaliveReply(json) {
  return json.id === "mm" && json.error === null && json.result instanceof Object && json.result.status === "KEEPALIVED";
}

module.exports = {
  connectPool,
  poolLoginParams,
  writePoolSocket,
};
