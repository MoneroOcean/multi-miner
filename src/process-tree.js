"use strict";

const childProcess = require("child_process");

function treeKill(pid, signal, callback) {
  let killSignal = signal;
  let killCallback = callback;
  if (typeof signal === "function" && callback === undefined) {
    killCallback = signal;
    killSignal = undefined;
  }
  if (!pid) {
    if (killCallback) killCallback();
    return;
  }

  switch (process.platform) {
    case "win32":
      childProcess.execFile("taskkill", ["/pid", String(pid), "/T", "/F"], killCallback || (() => {}));
      break;
    case "darwin":
      buildProcessTree(pid, spawnPgrep, (error, tree) => finishKill(error, tree, killSignal, killCallback));
      break;
    default:
      buildProcessTree(pid, spawnPs, (error, tree) => finishKill(error, tree, killSignal, killCallback));
  }
}

function spawnPgrep(parentPid) {
  return childProcess.spawn("pgrep", ["-P", String(parentPid)]);
}

function spawnPs(parentPid) {
  return childProcess.spawn("ps", ["-o", "pid", "--no-headers", "--ppid", String(parentPid)]);
}

function finishKill(error, tree, signal, callback) {
  if (error) {
    if (callback) callback(error);
    return;
  }
  try {
    killAll(tree, signal);
    if (callback) callback();
  } catch (killError) {
    if (callback) callback(killError);
    else throw killError;
  }
}

function buildProcessTree(rootPid, spawnChildren, callback) {
  const tree = {};
  const pending = new Set([String(rootPid)]);
  tree[rootPid] = [];

  function visit(parentPid) {
    const ps = spawnChildren(parentPid);
    let allData = "";
    ps.stdout.on("data", (data) => { allData += data.toString("ascii"); });
    ps.on("error", callback);
    ps.on("close", () => {
      pending.delete(String(parentPid));
      const matches = allData.match(/\d+/g) || [];
      for (const childPid of matches) {
        tree[parentPid].push(childPid);
        tree[childPid] = [];
        pending.add(String(childPid));
        visit(childPid);
      }
      if (pending.size === 0) callback(null, tree);
    });
  }

  visit(String(rootPid));
}

function killAll(tree, signal) {
  const killed = new Set();
  for (const pid of Object.keys(tree)) {
    for (const childPid of tree[pid]) killPidOnce(childPid, signal, killed);
    killPidOnce(pid, signal, killed);
  }
}

function killPidOnce(pid, signal, killed) {
  if (killed.has(String(pid))) return;
  try {
    process.kill(Number.parseInt(pid, 10), signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  killed.add(String(pid));
}

module.exports = {
  treeKill,
};
