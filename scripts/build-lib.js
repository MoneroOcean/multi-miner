"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const PKG_VERSION = "6.10.1";
const RUNTIME = "node22";

function pkgCommandAndArgs(args) {
  const pkgJson = path.resolve("node_modules", "@yao-pkg", "pkg", "package.json");
  if (fs.existsSync(pkgJson)) {
    const bin = path.join(path.dirname(pkgJson), require(pkgJson).bin.pkg);
    return { command: process.execPath, args: [bin].concat(args) };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command: npx, args: ["--yes", `@yao-pkg/pkg@${  PKG_VERSION}`].concat(args), shell: process.platform === "win32" };
}

function runPkg(target, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const pkg = pkgCommandAndArgs([".", "--public", "--no-bytecode", "--targets", target, "--output", output]);
  const result = childProcess.spawnSync(pkg.command, pkg.args, { stdio: "inherit", shell: pkg.shell || false });
  if (result.error) process.stderr.write(`Failed to start pkg: ${  result.error.message  }\n`);
  if (result.status !== 0) process.exit(result.status || 1);
}

function targetForCurrentPlatform() {
  const platformMap = { win32: "win", linux: "linux", darwin: "macos" };
  const archMap = { x64: "x64", arm64: "arm64" };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) throw new Error(`Unsupported platform for packaged build: ${  process.platform  }/${  process.arch}`);
  return `${RUNTIME  }-${  platform  }-${  arch}`;
}

function binaryName(platform) {
  return platform === "win" ? "mm.exe" : "mm";
}

module.exports = {
  RUNTIME,
  binaryName,
  runPkg,
  targetForCurrentPlatform,
};
