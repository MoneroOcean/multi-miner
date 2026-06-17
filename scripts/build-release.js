"use strict";

const path = require("path");
const { RUNTIME, binaryName, runPkg } = require("./build-lib");

const targets = [
  ["win", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["macos", "x64"],
  ["macos", "arm64"],
];

for (const [platform, arch] of targets) {
  const target = [RUNTIME, platform, arch].join("-");
  const output = path.join("dist", `${platform  }-${  arch}`, binaryName(platform));
  runPkg(target, output);
}
