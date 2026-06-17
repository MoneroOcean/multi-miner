"use strict";

const assert = require("assert");
const { stringifyLine } = require("../../src/json-lines");
const { ethSubscribeResult } = require("../../src/protocol");
const { createJsonLineServer } = require("./live-helpers");

const EASY_ETH_TARGET = process.env.MM_LIVE_EASY_ETH_TARGET || "00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const MAX_EXPLICIT_TARGET_DIFFICULTY = 1100000;

function createLiveFakePool(testCase) {
  let resolveLogin;
  const login = new Promise((resolve) => { resolveLogin = resolve; });
  const submits = [];
  return createJsonLineServer((socket, json) => handlePoolJson(socket, json, testCase, resolveLogin, submits), { login, submits });
}

function handlePoolJson(socket, json, testCase, resolveLogin, submits) {
  if (json.method === "login") {
    resolveLogin(json);
    socket.write(stringifyLine(testCase.kind === "eth" ? ethLoginReply(json.id) : poolLoginReply(json.id, testCase.algo)));
    if (testCase.kind === "eth") sendEthJob(socket, testCase);
    return;
  }
  if (json.method === "mining.subscribe") {
    socket.write(stringifyLine({ id: json.id, jsonrpc: "2.0", error: null, result: ethSubscribeResult("live") }));
    return;
  }
  if (json.method === "mining.extranonce.subscribe") {
    socket.write(stringifyLine({ id: json.id, jsonrpc: "2.0", error: null, result: true }));
    return;
  }
  if (json.method === "submit" || json.method === "mining.submit") {
    submits.push(json);
    socket.write(stringifyLine({ id: json.id, jsonrpc: "2.0", error: null, result: true }));
  }
}

function poolLoginReply(id, algo) {
  if (algo === "c29") return standardLoginReply(id, c29Job());
  if (algo === "ghostrider") return standardLoginReply(id, ghostriderJob());
  return standardLoginReply(id, {
    algo,
    blob: "7f7ffeeaa0db054f15eca39c843cb82c15e5c5a7743e06536cb541d4e96e90ffd31120b7703aa90000000076a6f6e34a9977c982629d8fe6c8b45024cafca109eef92198784891e0df41bc03",
    job_id: "live1",
    seed_hash: "0000000000000000000000000000000000000000000000000000000000000001",
    target: "ffffffff",
  });
}

function standardLoginReply(id, job) {
  return {
    id,
    jsonrpc: "2.0",
    error: null,
    result: { id: "pool-miner", status: "OK", job },
  };
}

function ethLoginReply(id) {
  return { id, jsonrpc: "2.0", error: null, result: { id: "pool-miner", status: "OK" } };
}

function sendEthJob(socket, testCase) {
  socket.write(stringifyLine(ethDifficultyMessage(testCase)));
  const notify = () => socket.writable && socket.write(stringifyLine({ jsonrpc: "2.0", method: "mining.notify", algo: testCase.algo, params: ethNotifyParams(testCase.algo) }));
  notify(); setTimeout(notify, 20000); setTimeout(notify, 40000);
}

function ethDifficultyMessage(testCase) {
  if (testCase.algo === "kawpow" || testCase.name.includes("ethproxy")) {
    return { jsonrpc: "2.0", id: null, method: "mining.set_target", params: [EASY_ETH_TARGET] };
  }
  return { jsonrpc: "2.0", method: "mining.set_difficulty", params: [0.001] };
}

function assertEasyEthTargets(cases) {
  for (const testCase of cases.filter((item) => item.kind === "eth")) {
    const message = ethDifficultyMessage(testCase);
    const value = message.method === "mining.set_target" ? targetDifficulty(message.params[0]) : Number(message.params[0]);
    const limit = message.method === "mining.set_target" ? MAX_EXPLICIT_TARGET_DIFFICULTY : 0.001;
    assert.ok(value > 0 && value <= limit, `${testCase.name} fake pool difficulty is too high: ${value}`);
  }
}

function targetDifficulty(targetHex) {
  const target = BigInt(`0x${  String(targetHex).replace(/^0x/i, "")}`);
  return target > 0n ? Number(((1n << 256n) - 1n) / target) : Infinity;
}

function ethNotifyParams(algo) {
  if (algo === "kawpow") {
    return [
      "0736",
      "bd4b63f88ca7d5a3521ee7ea88409b2f8b52275e329f8480b1e1677023c80e03",
      "5034b115f02d04f1fda6db059ec3d9a0edc53b13a8dbfb7b31cc9f5694bc8c36",
      EASY_ETH_TARGET,
      true,
      4359937,
      "1b024f68",
    ];
  }
  if (algo === "autolykos2") {
    return [
      "2515680",
      1782151,
      "ae46975734f151ad4ec2108b3338d11303dee60039be2f97c091a2363fb663a9",
      "",
      "",
      2,
      "35069091371184271909752748228449352580275790323363129582133370526447600",
      "",
      true,
    ];
  }
  return [
    "2544698",
    "8701f718d77327c969b22c6f24f0139befcba650537f1d135751b46f1421c7ca",
    "7e02c4fa5863363939f5a10fb07de4e185b35dd7bbe2226ad877e0d69fb8151c",
    true,
  ];
}

function ghostriderJob() {
  return {
    algo: "ghostrider",
    blob: "000000203f912906a05a588b9731c271e5268c15905bbfbda448f7c8950dbfa152fa75dc466f989bc64749f6a7fd0f80fc8e37d63a757d1cdc3882f974ce54ff3eb69d55bdfbff691e79071d00000000",
    height: 1339713,
    job_id: "live1",
    target: "ffffffff",
  };
}

function c29Job() {
  return {
    blob: "17b9ac16fe37c3e2f0bf8bb9fec6dae1f59a1f0ce1d40fdcfb33fab18b6ce28a",
    algo: "cuckaroo",
    proofsize: 42,
    noncebytes: 8,
    nonceoffset: 0,
    height: 260886,
    job_id: "live1",
    target: "ffffffffffffffff",
    id: "pool-miner",
    xn: "fd3e",
  };
}

module.exports = {
  assertEasyEthTargets,
  createLiveFakePool,
};
