"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { createJsonLineParser } = require("../../src/json-lines");

const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

function safeCaseName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "case";
}

function safeFailureClass(value) {
  const text = String(value || "").toLowerCase();
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/unsupported|not supported|unknown algorithm|no device|device not found/.test(text)) return "unsupported";
  if (/binary-unavailable|binary not found|required .* unavailable|missing/.test(text)) return "binary-unavailable";
  if (/permission|eacces|access denied/.test(text)) return "permission";
  if (/miner exited before a submit/.test(text)) return "native-exit";
  if (/login|connect|pool/.test(text)) return "pool-startup";
  if (/submit/.test(text)) return "submit";
  if (/protocol/.test(text)) return "protocol";
  if (/assert/.test(text)) return "assertion";
  if (/exit|signal|launch/.test(text)) return "native-exit";
  return "runtime";
}

function safeNativeCode(result) {
  const code = [result && result.nativeCode, result && result.exitCode].find((value) => Number.isInteger(value));
  return code === undefined ? "unknown" : String(code);
}

function safeNativeSignal(result) {
  const signal = result && (result.nativeSignal || result.signal);
  return typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) ? signal : "none";
}

function safeOutcome(value) { return value === "submit" ? "submit" : "other"; }

function safeProtocol(value) {
  return ["eth", "ethproxy", "stratum", "grin"].includes(value) ? value : "other";
}

function safeResultSummary(result) {
  const fields = [
    `case=${safeCaseName(result && result.name)}`,
    `status=${result && result.status === "passed" ? "passed" : result && result.status === "skipped" ? "skipped" : "failed"}`,
  ];
  if (result && result.status === "passed") {
    fields.push(`outcome=${safeOutcome(result.outcome)}`);
    fields.push(`protocol=${safeProtocol(result.protocol)}`);
    fields.push(`rateCount=${Number.isInteger(result.rates && result.rates.length) ? result.rates.length : 0}`);
  } else {
    fields.push(`failure=${safeFailureClass(result && (result.failureClass || result.reason))}`);
    fields.push(`nativeCode=${safeNativeCode(result)}`);
    fields.push(`nativeSignal=${safeNativeSignal(result)}`);
  }
  return fields.join(" ");
}

function assertNoLiveFailures(assert, results) {
  const failures = results.filter((result) => result.status === "failed");
  assert.equal(failures.length, 0, `live failure count=${failures.length}/${results.length}; ${failures.map(safeResultSummary).join("; ")}`);
}

function captureOutput(app, output) {
  let capturedChars = 0;
  const append = (message) => {
    let text = String(message);
    if (text.length > MAX_CAPTURE_CHARS) text = text.slice(-MAX_CAPTURE_CHARS);
    output.push(text);
    capturedChars += text.length;
    while (capturedChars > MAX_CAPTURE_CHARS && output.length > 1) {
      capturedChars -= output.shift().length;
    }
  };
  app.logger.log = (message) => append(`>>> ${  message}`);
  app.logger.err = (message) => append(`!!! ${  message}`);
  app.logger.miner = append;
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
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const parser = createJsonLineParser((json) => onLine(socket, json), undefined, extra && extra.maxLineBytes);
    socket.on("error", () => {});
    socket.on("data", (chunk) => parser.push(chunk));
  });
  let closePromise;
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve({
      close: () => {
        if (!closePromise) {
          closePromise = new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          });
        }
        return closePromise;
      },
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

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeLiveConfig(configPath, minerPort, poolPort, algo, command) {
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  writePrivateFile(configPath, JSON.stringify({
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

async function waitForLiveSubmit(pool, name, output, timeoutMs, minerExit) {
  const started = Date.now();
  let exitState;
  if (minerExit) minerExit.then((state) => { exitState = state; });
  while (Date.now() - started < timeoutMs) {
    if (pool.submits.length > 0) return "submit";
    if (exitState) {
      const code = Number.isInteger(exitState.code) ? exitState.code : "null";
      const signal = typeof exitState.signal === "string" && /^SIG[A-Z0-9]+$/.test(exitState.signal) ? exitState.signal : "none";
      const error = new Error(`${safeCaseName(name)} miner exited before a submit (code=${code}, signal=${signal})`);
      error.nativeCode = Number.isInteger(exitState.code) ? exitState.code : null;
      error.nativeSignal = signal === "none" ? null : signal;
      throw error;
    }
    await delay(500);
  }
  throw new Error(`${safeCaseName(name)} timed out before a submit`);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function printSimpleResult(prefix, result) {
  process.stdout.write(`${prefix}: ${safeResultSummary(result)}\n`);
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
  safeFailureClass,
  safeResultSummary,
  tail,
  waitForLiveSubmit,
  withTimeout,
  words,
  writePrivateFile,
  writeLiveConfig,
};
