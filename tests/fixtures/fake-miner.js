#!/usr/bin/env node
"use strict";

const net = require("net");
const { createJsonLineParser, stringifyLine } = require("../../src/json-lines");

const args = parseArgs(process.argv.slice(2));
const socket = net.connect(Number.parseInt(args.port || "3333", 10), args.host || "127.0.0.1");
let submitted = false;
let ethProxyHeader = "0x00";
const parser = createJsonLineParser(handleJson, () => {});

socket.on("connect", () => {
  if (args.protocol === "eth") {
    write({ id: 1, jsonrpc: "2.0", method: "mining.subscribe", params: [] });
    write({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: [args.user || "wallet", args.pass || "x"] });
    return;
  }
  if (args.protocol === "ethproxy") {
    write({ id: 1, jsonrpc: "2.0", method: "eth_submitLogin", params: [args.user || "wallet", args.pass || "x"], worker: "fake" });
    write({ id: 2, jsonrpc: "2.0", method: "eth_getWork", params: [] });
    return;
  }
  if (args.protocol === "grin") {
    write({ id: "Stratum", jsonrpc: "2.0", method: "login", params: { login: args.user || "wallet", pass: args.pass || "x", algorithm: "cuckarood29v" } });
    write({ id: "Stratum", jsonrpc: "2.0", method: "getjobtemplate", params: {} });
    return;
  }
  write({
    id: 1,
    jsonrpc: "2.0",
    method: "login",
    params: { login: args.user || "wallet", pass: args.pass || "x", algo: [args.algo || "rx/0"] },
  });
});

socket.on("data", (chunk) => parser.push(chunk));

socket.on("error", () => process.exit(2));

function handleJson(json) {
  if (submitted) return;
  if (json.method === "job" || (json.result && json.result.job)) submitDefault(json);
  if (json.method === "mining.notify") submitEth(json);
  if (json.method === "getjobtemplate") submitGrin(json);
  if (args.protocol === "ethproxy" && json.result && Array.isArray(json.result) && json.result.length >= 3) submitEthProxy(json.result[0]);
}

function submitDefault(json) {
  const job = json.method === "job" ? json.params : json.result.job;
  submitted = true;
  write({ id: 2, jsonrpc: "2.0", method: "submit", params: { id: "miner", job_id: job.job_id || job.id || "job1", nonce: "00", result: "00" } });
}

function submitEth(json) {
  submitted = true;
  const jobId = Array.isArray(json.params) ? json.params[0] : "job1";
  write({ id: 3, jsonrpc: "2.0", method: "mining.submit", params: [args.user || "wallet", jobId, "00", "00", "00"] });
}

function submitEthProxy(header) {
  submitted = true;
  ethProxyHeader = header || ethProxyHeader;
  write({ id: 3, jsonrpc: "2.0", method: "eth_submitWork", params: ["0x00", ethProxyHeader, "0x00"] });
}

function submitGrin() {
  submitted = true;
  write({ id: "Stratum", jsonrpc: "2.0", method: "submit", params: { height: 1, job_id: "job1", nonce: 1, pow: [] } });
}

function write(json) {
  socket.write(stringifyLine(json));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    result[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return result;
}
