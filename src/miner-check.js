"use strict";

const { assignAlgoCommand } = require("./algorithms");
const { benchmarkSubscribeReply } = require("./miner-server");
const { runSequential, treeKill } = require("./process-manager");

function setFirstMinerUserPass(config, json, logger, verbose) {
  if (!json.params || typeof json.params !== "object") return;
  if (config.user === null) {
    if (json.method === "login" && "login" in json.params) config.user = json.params.login;
    if (json.method === "mining.authorize" && Array.isArray(json.params)) config.user = json.params[0];
    if (json.method === "eth_submitLogin" && Array.isArray(json.params)) config.user = json.params[0];
    if (verbose && logger) logger.log(`Setting pool user to '${  config.user  }'`);
  }
  if (config.pass === null) {
    if (json.method === "login" && "pass" in json.params) config.pass = json.params.pass;
    if (json.method === "mining.authorize" && Array.isArray(json.params)) config.pass = json.params[1];
    if (json.method === "eth_submitLogin" && Array.isArray(json.params)) config.pass = json.params[1];
    if (verbose && logger) logger.log(`Setting pool pass to '${  config.pass  }'`);
  }
}

function checkMiners(options, callback) {
  const queue = [];
  for (const cmd of options.smartMiners) queue.push((resolve) => checkSmartMiner(options, cmd, resolve));
  for (const [algo, cmd] of Object.entries(options.miners)) {
    queue.push((resolve) => checkAlgoMiner(options, algo, cmd, resolve));
  }

  if (!options.flags.quiet && queue.length) {
    options.logger.log(`Checking miner configurations (make sure they are all configured to connect to ${  options.config.miner_host  }:${  options.config.miner_port  } pool)`);
  }

  runSequential(queue, callback);
}

function checkSmartMiner(options, cmd, resolve) {
  runMinerCheck(options, cmd, (json) => {
    setFirstMinerUserPass(options.config, json, options.logger, options.flags.verbose);
    const algos = json.params && Array.isArray(json.params.algo) ? json.params.algo : [];
    if (algos.length === 0) {
      options.logger.err(`Miner '${  cmd  }' does not report any algo and will be ignored`);
      return;
    }
    for (const algo of algos) setAlgo(options, algo, cmd);
  }, resolve);
}

function checkAlgoMiner(options, algo, cmd, resolve) {
  runMinerCheck(options, cmd, (json) => {
    setFirstMinerUserPass(options.config, json, options.logger, options.flags.verbose);
    setAlgo(options, algo, cmd);
  }, resolve);
}

function runMinerCheck(options, cmd, onLogin, resolve) {
  let minerProc = null;
  let completed = false;
  const timeout = setTimeout(() => {
    if (completed) return;
    options.logger.err(`Miner '${  cmd  }' was not connected and will be ignored`);
    finish();
  }, options.timeoutMs || 60 * 1000);

  function finish() {
    completed = true;
    clearTimeout(timeout);
    if (!minerProc) {
      resolve();
      return;
    }
    minerProc.once("close", resolve);
    treeKill(minerProc.pid);
  }

  options.server.setHandlers({
    login(json) {
      if (completed) return;
      onLogin(json);
      finish();
    },
    firstJob() {},
    subscribe(json, minerSocket) {
      options.server.write(minerSocket, benchmarkSubscribeReply(json, "check"));
    },
  });

  minerProc = options.startMiner(cmd, options.printMessages);
}

function setAlgo(options, algo, cmd) {
  if (options.flags.verbose) {
    const current = options.config.algos[algo];
    if (current) options.logger.log(`Setting ${  algo  } algo from '${  current  }' to '${  cmd  }' miner`);
    else options.logger.log(`Setting ${  algo  } algo to '${  cmd  }' miner`);
  }
  assignAlgoCommand(options.config, algo, cmd);
}

module.exports = {
  checkMiners,
  setFirstMinerUserPass,
};
