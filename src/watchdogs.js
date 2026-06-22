"use strict";

const { localAlgoPerf } = require("./algorithms");

function startWatchdogs(app) {
  if (app.config.watchdog) startSubmitWatchdog(app);
  if (app.config.hashrate_watchdog) startHashrateWatchdog(app);
}

function startSubmitWatchdog(app) {
  if (app.flags.verbose) app.logger.log(`Starting miner watchdog timer (with ${  app.config.watchdog  } seconds max since last miner result)`);
  const timer = setInterval(() => {
    if (app.currPoolSocket) app.writePool({ jsonrpc: "2.0", id: "mm", method: "keepalived", params: {} });
    if (!app.currPoolSocket || !app.minerServer.socket || app.minerLastSubmitTime === null) return;
    const idleTime = (Date.now() - app.minerLastSubmitTime) / 1000;
    if (idleTime > app.config.watchdog) {
      app.logger.err(`No results from miner for more than ${  app.config.watchdog  } seconds. Restarting it...`);
      app.minerLastSubmitTime = Date.now();
      app.replaceMiner(app.currMiner);
    }
  }, app.options.watchdogIntervalMs || 60 * 1000);
  app.watchdogTimers.push(timer);
}

function startHashrateWatchdog(app) {
  if (app.flags.verbose) app.logger.log(`Starting miner hashrate watchdog timer (with ${  app.config.hashrate_watchdog  }% min hashrate threshold)`);
  const timer = setInterval(() => {
    if (!app.currPoolSocket || !app.minerServer.socket || app.lastMinerHashrate === null) return;
    if (app.lastAlgoChangeTime && Date.now() - app.lastAlgoChangeTime < 15 * 60 * 1000) return;
    const minHashrate = localAlgoPerf(app.config, app.currAlgo) * app.config.hashrate_watchdog / 100;
    if (app.lastMinerHashrate < minHashrate) {
      app.logger.err(`Current miner hashrate ${  app.lastMinerHashrate  } is below minimum ${  minHashrate  } hashrate threshold. Restarting it...`);
      app.replaceMiner(app.currMiner);
    }
  }, app.options.watchdogIntervalMs || 60 * 1000);
  app.watchdogTimers.push(timer);
}

module.exports = {
  startWatchdogs,
};
