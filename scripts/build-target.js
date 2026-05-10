"use strict";

const path = require("path");
const { RUNTIME, binaryName, runPkg } = require("./build-lib");

const TARGETS = {
  "win-x64": ["win", "x64"],
  "linux-x64": ["linux", "x64"],
  "linux-arm64": ["linux", "arm64"],
  "macos-x64": ["macos", "x64"],
  "macos-arm64": ["macos", "arm64"],
};

const name = process.argv[2];
if (!TARGETS[name]) {
  process.stderr.write("Usage: node scripts/build-target.js <" + Object.keys(TARGETS).join("|") + ">\n");
  process.exit(1);
}

const [platform, arch] = TARGETS[name];
runPkg([RUNTIME, platform, arch].join("-"), path.join("dist", name, binaryName(platform)));
