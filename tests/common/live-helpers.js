"use strict";

const fs = require("fs");
const net = require("net");
const { createJsonLineParser } = require("../../src/json-lines");

function assertNoLiveFailures(assert, results) {
  const failures = results.filter((result) => result.status === "failed");
  assert.equal(failures.length, 0, failures.map((result) => `${result.name  }: ${  result.reason  }\n${  result.output || ""}`).join("\n"));
}

function captureOutput(app, output) {
  app.logger.log = (message) => output.push(`>>> ${  message}`);
  app.logger.err = (message) => output.push(`!!! ${  message}`);
  app.logger.miner = (message) => output.push(String(message));
}

function envInt(name, fallback) { return Number.parseInt(process.env[name] || String(fallback), 10); }

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function createJsonLineServer(onLine, extra) {
  const server = net.createServer((socket) => {
    const parser = createJsonLineParser((json) => onLine(socket, json));
    socket.on("error", () => {});
    socket.on("data", (chunk) => parser.push(chunk));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve({
      close: () => new Promise((done) => server.close(done)),
      port: server.address().port,
      ...(extra || {}),
    }));
    server.on("error", reject);
  });
}

function quoteForCommand(value) { return `"${  String(value).replace(/["\\$`]/g, "\\$&")  }"`; }

function shellQuote(value) { return `'${  String(value).replace(/'/g, "'\\''")  }'`; }

function selectedCases(cases, envName) {
  const requested = new Set((process.env[envName] || "").split(",").filter(Boolean));
  return cases.filter((testCase) => !requested.size || requested.has(testCase.name));
}

function writeLiveConfig(configPath, minerPort, poolPort, algo, command) {
  fs.writeFileSync(configPath, JSON.stringify({
    miner_host: "127.0.0.1",
    miner_port: minerPort,
    pools: [`127.0.0.1:${  poolPort}`],
    algos: { [algo]: command },
    algo_perf: { [algo]: 1 },
    user: "wallet",
    pass: "x",
    watchdog: 0,
    hashrate_watchdog: 0,
  }, null, 2));
}

function tail(text) { return text.split(/\r?\n/).slice(-80).join("\n"); }

async function waitForLiveSubmit(pool, name, output, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pool.submits.length > 0) return "submit";
    await delay(500);
  }
  throw new Error(`${name  } timed out; tail:\n${  tail(output.join("\n"))}`);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function printSimpleResult(prefix, result) {
  const suffix = result.status === "passed" ? `(${  result.outcome  })` : result.reason;
  process.stdout.write(`${prefix  }: ${  result.name  } ${  result.status  } ${  suffix  }\n`);
}

function words(value) { return value.trim().split(/\s+/).filter(Boolean); }

module.exports = {
  assertNoLiveFailures,
  captureOutput,
  createJsonLineServer,
  delay,
  envInt,
  freePort,
  printSimpleResult,
  quoteForCommand,
  selectedCases,
  shellQuote,
  tail,
  waitForLiveSubmit,
  withTimeout,
  words,
  writeLiveConfig,
};
