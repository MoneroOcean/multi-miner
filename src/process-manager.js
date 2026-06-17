"use strict";

const childProcess = require("child_process");
const { formatCommand, splitCommand } = require("./command");
const { treeKill } = require("./process-tree");

function startMinerRaw(exe, args, options) {
  const opts = options || {};
  const cmd = formatCommand(exe, args);
  if (opts.verbose && opts.logger) opts.logger.log(`Starting miner: ${  cmd}`);
  const spawnOptions = opts.minerStdin ? { stdio: ["inherit", "pipe", "pipe"] } : {};
  const proc = childProcess.spawn(exe, args, spawnOptions);

  if (proc.stdout) proc.stdout.on("data", (data) => { if (opts.onOutput) opts.onOutput(String(data)); });
  if (proc.stderr) proc.stderr.on("data", (data) => { if (opts.onOutput) opts.onOutput(String(data)); });
  proc.on("error", (error) => {
    if (opts.logger) opts.logger.err(`Failed to start '${  cmd  }' miner: ${  error.message}`);
  });
  return proc;
}

function startMiner(command, options) {
  const parsed = splitCommand(command);
  return startMinerRaw(parsed.exe, parsed.args, options);
}

module.exports = {
  startMiner,
  treeKill,
};
