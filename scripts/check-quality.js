"use strict";

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.resolve(__dirname, "..", "src");
const ROOT_FILES = [path.resolve(__dirname, "..", "mm.js")];
const MAX_CRAP = 30;

let failures = 0;

for (const file of ROOT_FILES) checkFile(file);
for (const file of fs.readdirSync(SRC_DIR).filter((name) => name.endsWith(".js"))) checkFile(path.join(SRC_DIR, file));

if (failures) process.exit(1);
process.stdout.write("quality: CRAP proxy checks passed\n");

function checkFunctions(file, text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const name = functionName(lines[i]);
    if (!name) continue;
    const body = collectBody(lines, i);
    if (!body) continue;
    const crap = complexity(body);
    if (crap >= MAX_CRAP) fail(`${file  }:${  i + 1  } ${  name  } has CRAP proxy ${  crap  }, max is ${  MAX_CRAP - 1}`);
  }
}

function checkFile(abs) {
  const label = path.relative(path.resolve(__dirname, ".."), abs);
  const text = fs.readFileSync(abs, "utf8");
  checkFunctions(label, text);
}

function functionName(line) {
  let match = line.match(/^\s*function\s+([A-Za-z0-9_]+)/);
  if (match) return match[1];
  match = line.match(/^\s*(?:async\s+)?([A-Za-z0-9_]+)\([^)]*\)\s*\{/);
  if (match && !["if", "for", "while", "switch", "catch"].includes(match[1])) return match[1];
  match = line.match(/^\s*(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
  return match ? match[1] : null;
}

function collectBody(lines, start) {
  let depth = 0;
  let seen = false;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const line = stripStrings(lines[i]);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    body.push(line);
    if (seen && depth <= 0) return body.join("\n");
  }
  return null;
}

function complexity(body) {
  const checks = [
    /\bif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /\?/g,
  ];
  return 1 + checks.reduce((sum, regex) => sum + count(body, regex), 0);
}

function count(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function stripStrings(line) {
  return line.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, "\"\"").replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
}

function fail(message) {
  failures++;
  process.stderr.write(`quality: ${  message  }\n`);
}
