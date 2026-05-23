#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const path = require("path");

const targets = [
  { name: "cpu", script: "live-cpu-miners.js" },
  { name: "intel-gpu", script: "live-intel-gpu-miners.js" },
  { name: "nvidia-gpu", script: "live-nvidia-gpu-miners.js" },
];
const CASE_LABELS = {
  "xmrig-rx-0": "XMRig rx/0",
  "xmrig-rx-graft": "XMRig rx/graft",
  "xmrig-rx-arq": "XMRig rx/arq",
  "xmrig-cn-r": "XMRig cn/r",
  "xmrig-cn-heavy-xhv": "XMRig cn-heavy/xhv",
  "xmrig-cn-pico-trtl": "XMRig cn-pico/trtl",
  "xmrig-ghostrider": "XMRig ghostrider",
  "xmrig-panthera": "XMRig panthera",
  "srbminer-cn-gpu": "SRBMiner cn/gpu",
  "mo-miner-c29": "mo-miner c29",
  "srbminer-autolykos2": "SRBMiner autolykos2",
  "srbminer-etchash": "SRBMiner etchash stratum",
  "srbminer-etchash-ethstratum2": "SRBMiner etchash stratum2",
  "srbminer-etchash-ethproxy": "SRBMiner etchash eth_getWork",
  "srbminer-kawpow": "SRBMiner kawpow",
  "lolminer-autolykos2": "lolMiner autolykos2",
  "lolminer-etchash": "lolMiner etchash ETHV1",
  "lolminer-etchash-ethproxy": "lolMiner etchash ETHPROXY",
  "lolminer-c29": "lolMiner c29",
  "gminer-autolykos2": "GMiner autolykos2",
  "gminer-etchash": "GMiner etchash",
  "gminer-kawpow": "GMiner kawpow",
  "rigel-autolykos2": "Rigel autolykos2",
  "rigel-etchash": "Rigel etchash",
  "rigel-kawpow": "Rigel kawpow",
  "trex-autolykos2": "T-Rex autolykos2",
  "trex-etchash": "T-Rex etchash eth_getWork",
  "trex-etchash-stratum2": "T-Rex etchash stratum2",
  "trex-kawpow": "T-Rex kawpow",
  "xmrig-cuda-rx-0": "XMRig CUDA rx/0",
};
const colorsEnabled = shouldUseColor();

main().catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});

async function main() {
  const started = Date.now();
  const results = [];
  process.stdout.write(color("bold", "▶ live") + "\n");

  for (const target of targets) {
    results.push(await runTarget(target));
  }

  process.stdout.write(color("green", "✔") + " live " + color("gray", "(" + formatDuration(Date.now() - started) + ")") + "\n");

  const failures = results.filter((result) => result.error || result.status !== 0);
  if (failures.length === 0) return;

  process.stdout.write("\nFailed live test logs:\n");
  for (const failure of failures) {
    process.stdout.write("\n--- " + failure.name + " ---\n");
    if (failure.error) process.stdout.write(String(failure.error.stack || failure.error) + "\n");
    process.stdout.write(failure.output || "(no output)\n");
  }
  process.exit(1);
}

function runTarget(target) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let stdoutBuffer = "";
    const cases = [];
    let spawnError = null;

    process.stdout.write("\n  " + color("bold", "▶ " + target.name) + "\n");
    const child = childProcess.spawn(process.execPath, [path.join("tests", target.script)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      stdoutBuffer = processStdoutLines(stdoutBuffer + text, cases);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status) => {
      stdoutBuffer = processStdoutLines(stdoutBuffer + "\n", cases);
      if (cases.length === 0) printCase({ name: "startup", status: status === 0 && !spawnError ? "passed" : "failed", detail: "" });
      const failed = spawnError || status !== 0;
      process.stdout.write("  " + statusIcon(failed ? "failed" : "passed") + " " + target.name + " " + color("gray", "(" + formatDuration(Date.now() - started) + ")") + "\n");
      resolve({ cases, durationMs: Date.now() - started, error: spawnError, name: target.name, output, status });
    });
  });
}

function processStdoutLines(text, cases) {
  const lines = text.split(/\r?\n/);
  const remaining = lines.pop();
  for (const line of lines) {
    const testCase = parseLine(line);
    if (!testCase) continue;
    cases.push(testCase);
    printCase(testCase);
  }
  return remaining;
}

function parseLine(line) {
  const suiteSkip = line.match(/^live-[^:\n]+: skipped: ([^\n]+)/);
  if (suiteSkip) return { name: "availability", status: "skipped", detail: suiteSkip[1].trim() };
  const testCase = line.match(/^live-[^:\n]+: ([^\s:]+) (passed|skipped|failed)\s*([^\n]*)/);
  if (!testCase) return null;
  return { name: displayCaseName(testCase[1]), status: testCase[2], detail: testCase[3].trim() };
}

function printCase(testCase) {
  const line = "    " + statusIcon(testCase.status) + " " + testCase.name + detailText(testCase);
  process.stdout.write((testCase.status === "skipped" ? color("gray", line) : line) + "\n");
}

function statusIcon(status) {
  if (status === "failed") return color("red", "✖");
  if (status === "skipped") return "✔";
  return color("green", "✔");
}

function detailText(testCase) {
  if (!testCase.detail) return "";
  if (testCase.status === "skipped") return " # SKIP " + testCase.detail;
  return " " + color("gray", testCase.detail);
}

function displayCaseName(name) {
  if (CASE_LABELS[name]) return CASE_LABELS[name];
  return name
    .replace(/-ethproxy\b/g, " eth_getWork")
    .replace(/-stratum2\b/g, " stratum2")
    .replace(/-/g, " ");
}

function formatDuration(ms) { return ms < 1000 ? ms.toFixed(0) + "ms" : (ms / 1000).toFixed(1) + "s"; }

function shouldUseColor() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if ("NO_COLOR" in process.env || process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

function color(name, text) {
  if (!colorsEnabled) return text;
  const codes = {
    bold: [1, 22],
    gray: [90, 39],
    green: [32, 39],
    red: [31, 39],
  };
  return "\u001b[" + codes[name][0] + "m" + text + "\u001b[" + codes[name][1] + "m";
}
