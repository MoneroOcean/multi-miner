"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, ".cache", "live-miners");

function liveMinerRoot() { return process.env.MM_LIVE_MINER_ROOT || process.env.MM_LIVE_CACHE_DIR || DEFAULT_CACHE_DIR; }

function findMinerBinary(cacheKey, binaryName) { return findNewestNamedFile(path.join(liveMinerRoot(), cacheKey), binaryName); }

function findConfiguredMinerBinary(envName, cacheKey, binaryName) {
  const configured = process.env[envName];
  return configured && fs.existsSync(configured) ? configured : findMinerBinary(cacheKey, binaryName);
}

function findMinerCommandDir(cacheKey, command) { return findMinerCommandDirIn(liveMinerRoot(), cacheKey, command); }

function findMinerCommandDirIn(cacheRoot, cacheKey, command) {
  const root = path.join(cacheRoot, cacheKey);
  const match = command.match(/(?:^|\s)\.\/([^\s]+)/);
  if (!match) return fs.existsSync(root) ? root : "";
  const direct = path.join(root, match[1]);
  if (fs.existsSync(direct)) return root;
  const found = findNewestNamedFile(root, match[1]);
  return found ? path.dirname(found) : "";
}

function findNewestNamedFile(root, name) {
  const matches = findNamedFiles(root, name);
  matches.sort((a, b) => fileRank(a) - fileRank(b) || a.localeCompare(b, undefined, { numeric: true }));
  return matches[matches.length - 1] || "";
}

function fileRank(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function findNamedFiles(root, name) {
  if (!fs.existsSync(root)) return [];
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) matches.push(file);
    if (entry.isDirectory()) {
      matches.push(...findNamedFiles(file, name));
    }
  }
  return matches;
}

module.exports = {
  DEFAULT_CACHE_DIR,
  findConfiguredMinerBinary,
  findMinerBinary,
  findMinerCommandDir,
  liveMinerRoot,
};
