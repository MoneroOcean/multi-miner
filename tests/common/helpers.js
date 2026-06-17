"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDefaultConfig, createDefaultFlags } = require("../../src/config");
const { stringifyLine } = require("../../src/json-lines");
const { ethSubscribeResult } = require("../../src/protocol");
const { createJsonLineServer, freePort } = require("./live-helpers");

function baseParseOptions(extra) {
  return Object.assign({
    config: createDefaultConfig(),
    flags: createDefaultFlags(),
    logger: silentLogger(),
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mm-parse-")),
  }, extra || {});
}

function silentLogger() {
  return { err() {}, log() {}, verbose() {} };
}

function nearlyEqual(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(1e-9, expected * 1e-9);
}

function fakeMinerCommand(port, protocol, algo) {
  return `${quote(process.execPath)  } ${  quote(path.join(__dirname, "..", "fixtures", "fake-miner.js")) 
    } --host 127.0.0.1 --port ${  port  } --protocol ${  protocol  } --algo ${  algo}`;
}

function quote(value) {
  return `"${  String(value).replace(/"/g, "\\\"")  }"`;
}

function createFakePool(algo, mode) {
  let resolveLogin;
  let resolveSubmit;
  const login = new Promise((resolve) => { resolveLogin = resolve; });
  const submit = new Promise((resolve) => { resolveSubmit = resolve; });
  return createJsonLineServer((socket, json) => handlePoolJson(socket, json, algo, mode, resolveLogin, resolveSubmit), { login, submit });
}

function handlePoolJson(socket, json, algo, mode, resolveLogin, resolveSubmit) {
  if (json.method === "login") {
    resolveLogin(json);
    socket.write(stringifyLine(poolLoginReply(algo, mode)));
    if (mode === "eth") sendEthJob(socket, algo);
    return;
  }
  if (json.method === "mining.subscribe") {
    socket.write(stringifyLine({ id: json.id, jsonrpc: "2.0", error: null, result: ethSubscribeResult("test") }));
    return;
  }
  if (json.method === "submit" || json.method === "mining.submit") resolveSubmit(json);
}

function poolLoginReply(algo, mode) {
  if (mode === "eth") {
    return {
      id: 1,
      jsonrpc: "2.0",
      error: null,
      result: { id: "pool-miner", status: "OK" },
    };
  }
  return {
    id: 1,
    jsonrpc: "2.0",
    error: null,
    result: {
      id: "pool-miner",
      job: {
        algo,
        blob: "00",
        job_id: "job1",
        seed_hash: "00",
        target: "01000000",
      },
      status: "OK",
    },
  };
}

function sendEthJob(socket) {
  socket.write(stringifyLine({ jsonrpc: "2.0", method: "mining.set_difficulty", params: [0.000001] }));
  socket.write(stringifyLine({ jsonrpc: "2.0", method: "mining.notify", algo: "etchash", params: ethNotifyParams() }));
}

function ethNotifyParams(jobId) {
  return [
    jobId || "job1",
    "e79f0f63030bf691445c2b9d0266b24a9619e355194067f2ad2c73a8e0a26c65",
    "feb4243b885cd1af5337979f5d81849335cab197b4993e5c61ea4b43b43dbbc6",
    true,
  ];
}

module.exports = {
  baseParseOptions,
  createFakePool,
  ethNotifyParams,
  fakeMinerCommand,
  freePort,
  nearlyEqual,
  silentLogger,
};
