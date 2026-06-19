#!/usr/bin/env node
"use strict";

const { DEFAULT_ALGO, localAlgoPerf, normalizePoolAlgo } = require("./src/algorithms");
const { runBenchmarkRuns } = require("./src/benchmark");
const { createDefaultConfig, createDefaultFlags, parseArgs, printHelp, saveConfigFile } = require("./src/config");
const { formatDiagnostics, validateConfig } = require("./src/diagnostics");
const { forEachHashrate } = require("./src/hashrate");
const { Logger } = require("./src/logger");
const { checkMiners } = require("./src/miner-check");
const { MinerServer } = require("./src/miner-server");
const { connectPool, writePoolSocket } = require("./src/pool-client");
const { createEthProxyWorkTracker, detectMinerProtocol, ethProxySubmit, ethProxyWork, grinJsonReply, isEthProxyWorkResult, jsonError, jsonReply } = require("./src/protocol");
const { startMiner, treeKill } = require("./src/process-manager");
const { stringifyLine } = require("./src/json-lines");

const VERSION = "v5.0";
const AGENT = `Multi-Miner ${  VERSION}`;

class MultiMinerApp {
  constructor(argv, options) {
    this.argv = argv || [];
    this.options = options || {};
    this.config = createDefaultConfig();
    this.flags = createDefaultFlags();
    this.logger = new Logger(this.config, this.flags);
    this.currPoolSocket = null;
    this.currPoolLastJob = null;
    this.currPoolMinerId = null;
    this.currPoolLastTarget = null;
    this.ethProxyWork = createEthProxyWorkTracker();
    this.pendingEthFirstJob = this.pendingEthSubscribeId = this.pendingEthFirstJobTimer = null;
    this.delayNextEthFirstJob = false;
    this.currPoolNum = 0;
    this.currMiner = null;
    this.currAlgo = null;
    this.lastAlgoChangeTime = null;
    this.lastMinerHashrate = null;
    this.mainPoolCheckTimer = null;
    this.poolReconnectTimer = null;
    this.minerProc = null;
    this.nextMinerToRun = null;
    this.isWantMinerKill = false;
    this.minerLastSubmitTime = null;
    this.watchdogTimers = [];
    this.minerServer = new MinerServer({
      config: this.config,
      flags: this.flags,
      logger: this.logger,
      getPoolSocket: () => this.currPoolSocket,
      getPoolLabel: () => this.poolLabel(),
      getCurrentMiner: () => this.currMiner,
      replaceMiner: (cmd) => this.replaceMiner(cmd),
      onSubmit: () => { this.minerLastSubmitTime = Date.now(); },
    });
  }

  async run() {
    this.logger.log(`Multi-Miner ${  VERSION}`);
    const parsed = parseArgs(this.argv, {
      config: this.config,
      flags: this.flags,
      logger: this.logger,
      cwd: this.options.cwd,
    });
    this.configFile = parsed.configFile;

    if (this.flags.help) {
      printHelp();
      return 0;
    }
    if (parsed.noArgsMissingDefault) {
      printHelp();
      return 1;
    }
    if (this.flags.diagnostics) {
      process.stdout.write(`${formatDiagnostics(this.config)  }\n`);
      return validateConfig(this.config).errors.length ? 1 : 0;
    }

    await this.listen();
    if (!this.options.skipMinerCheck) await this.checkMiners(parsed);
    const diagnostics = validateConfig(this.config);
    if (diagnostics.errors.length) {
      for (const error of diagnostics.errors) this.logger.err(`[FATAL] ${  error}`);
      await this.closeServer();
      return 1;
    }
    if (process.title !== this.config.proc_title) process.title = this.config.proc_title;
    await this.runBenchmarks(); this.main(); return undefined;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.minerServer.server.once("error", reject);
      this.minerServer.listen(() => {
        this.minerServer.server.removeListener("error", reject);
        if (this.flags.verbose) {
          this.logger.log(`Local miner server on ${  this.config.miner_host  }:${  this.config.miner_port  } port started`);
        }
        resolve();
      });
    });
  }
  closeServer() { return new Promise((resolve) => this.minerServer.close(resolve)); }
  checkMiners(parsed) {
    return new Promise((resolve) => {
      checkMiners({
        config: this.config,
        flags: this.flags,
        logger: this.logger,
        miners: parsed.miners,
        printMessages: (str) => this.printMessages(str),
        server: this.minerServer,
        smartMiners: parsed.smartMiners,
        startMiner: (cmd, outCb) => this.startMinerProcess(cmd, outCb),
        timeoutMs: this.options.checkTimeoutMs,
      }, resolve);
    });
  }
  runBenchmarks() {
    return new Promise((resolve) => {
      runBenchmarkRuns({
        config: this.config,
        logger: this.logger,
        printMessages: (str) => this.printMessages(str),
        server: this.minerServer,
        startMiner: (cmd, outCb) => this.startMinerProcess(cmd, outCb),
        timeoutMs: this.options.benchmarkTimeoutMs,
      }, resolve);
    });
  }

  main() {
    this.printParams();
    this.logger.log(`POOL USER: '${  this.config.user  }', PASS: '${  this.config.pass  }'`);
    this.setRuntimeMinerHandlers();
    this.startWatchdogs();
    this.connectPool(0);
  }

  async stop() {
    for (const timer of this.watchdogTimers) clearInterval(timer);
    this.watchdogTimers = [];
    clearTimeout(this.mainPoolCheckTimer);
    this.mainPoolCheckTimer = null;
    clearTimeout(this.poolReconnectTimer);
    this.poolReconnectTimer = null;
    clearTimeout(this.pendingEthFirstJobTimer);
    this.pendingEthFirstJobTimer = null;
    if (this.currPoolSocket) this.currPoolSocket.destroy();
    this.currPoolSocket = null;
    this.ethProxyWork.clear();
    if (this.minerProc && this.minerProc.pid) {
      await new Promise((resolve) => treeKill(this.minerProc.pid, resolve));
    }
    this.minerProc = null;
    await this.closeServer();
  }
  printParams() {
    const body = JSON.stringify(this.config, null, " ");
    if (this.flags.verbose) {
      this.logger.log("");
      this.logger.log("SETUP COMPLETE");
      this.logger.log(body);
      this.logger.log("");
      this.logger.log(`Saving ${  this.configFile  } config file`);
    }
    if (!this.flags.noConfigSave) saveConfigFile(this.configFile, this.config, this.logger);
  }
  setRuntimeMinerHandlers() {
    this.minerServer.setHandlers({
      login: (json, socket) => this.handleMinerLogin(json, socket),
      firstJob: (json, socket) => this.sendFirstJob(json, socket),
      subscribe: (json, socket) => this.handleMinerSubscribe(json, socket),
      extranonceSubscribe: (json, socket) => this.handleMinerExtranonceSubscribe(json, socket),
      submitWork: (json, socket) => this.handleEthProxySubmit(json, socket),
    });
  }
  handleMinerLogin(json, socket) {
    if (this.currPoolSocket && !this.minerServer.socket) {
      this.logger.log(`Pool (${  this.poolLabel()  }) <-> miner link was established due to new miner connection`);
    }
    const protocol = detectMinerProtocol(json);
    this.minerServer.setCurrent(socket, protocol);
    if (protocol === "ethproxy") this.ethProxyWork.clear();
    if (protocol === "grin") this.minerServer.write(socket, grinJsonReply("login", "ok"));
    if (protocol === "eth" || protocol === "ethproxy") this.minerServer.write(socket, jsonReply(json, true));
  }
  sendFirstJob(json, socket) {
    if (!this.currPoolLastJob) {
      this.logger.err(`No pool (${  this.poolLabel()  }) job to send to the miner!`);
      return;
    }
    if (this.minerServer.protocol === "grin") {
      this.minerServer.write(socket, grinJsonReply("getjobtemplate", this.currPoolLastJob));
      return;
    }
    if (this.minerServer.protocol === "eth") {
      if (this.pendingEthSubscribeId !== null || this.delayNextEthFirstJob) { this.pendingEthFirstJob = { json, socket }; this.schedulePendingEthFirstJob(); return; }
      if (Array.isArray(this.currPoolLastJob)) {
        if (this.shouldSendEthTarget()) this.minerServer.write(socket, stringifyLine(this.currPoolLastTarget));
        this.minerServer.write(socket, stringifyLine({ jsonrpc: "2.0", method: "mining.notify", algo: this.currAlgo, params: this.currPoolLastJob }));
      } else this.minerServer.write(socket, stringifyLine({ jsonrpc: "2.0", method: "job", params: this.currPoolLastJob }));
      return;
    }
    if (this.minerServer.protocol === "ethproxy") {
      const work = ethProxyWork(this.currPoolLastJob, this.currPoolLastTarget);
      this.ethProxyWork.remember(this.currPoolLastJob, work);
      this.minerServer.write(socket, jsonReply(json, work));
      return;
    }
    const reply = { jsonrpc: "2.0", error: null, result: { id: this.currPoolMinerId, job: this.currPoolLastJob, status: "OK" } };
    if ("id" in json) reply.id = json.id;
    this.minerServer.write(socket, stringifyLine(reply));
  }

  handleMinerSubscribe(json, socket) {
    if (this.minerServer.socket) {
      this.replaceMiner(this.currMiner);
      return;
    }
    if (this.currPoolSocket) {
      this.minerServer.setCurrent(socket, "eth");
      this.pendingEthFirstJob = null;
      this.pendingEthSubscribeId = json.id;
      this.delayNextEthFirstJob = true;
      this.writePool(json);
      return;
    }
    this.logger.err(`No active pool (${  this.poolLabel()  }) to send subscribe job to the miner!`);
    this.minerServer.write(socket, jsonError(json, "No active Multi-Miner pool"));
  }
  handleMinerExtranonceSubscribe(json, socket) { this.minerServer.write(socket, jsonReply(json, true)); if (this.minerServer.protocol === "eth") this.flushPendingEthFirstJob(); }
  handleEthProxySubmit(json, socket) {
    if (!this.currPoolSocket) {
      this.logger.err(`Dropping ETH proxy submitWork (replied rejected) since pool (${this.poolLabel()}) socket is closed`);
      this.minerServer.write(socket, jsonReply(json, false));
      return;
    }
    const job = this.ethProxyWork.getJob(json);
    if (!job) {
      this.logger.err("Ignoring ETH proxy submitWork with unknown work header");
      this.minerServer.write(socket, jsonReply(json, false));
      return;
    }
    this.minerLastSubmitTime = Date.now();
    this.writePool(ethProxySubmit(json, this.config.user, job));
  }
  connectPool(poolNum) {
    connectPool({
      agent: AGENT,
      config: this.config,
      debug: this.flags.debug,
      logger: this.logger,
      onError: (num) => this.poolErr(num),
      onMessage: (json) => this.poolNewMsg(json),
      onOk: (num, socket) => this.poolOk(num, socket),
      poolNum,
      verbose: this.flags.verbose,
    });
  }

  poolOk(poolNum, poolSocket) {
    if (poolNum) {
      if (!this.mainPoolCheckTimer) this.setMainPoolCheckTimer();
    } else if (this.mainPoolCheckTimer) {
      if (this.flags.verbose) this.logger.log("Stopped main pool connection attempts since its connection was established");
      clearTimeout(this.mainPoolCheckTimer);
      this.mainPoolCheckTimer = null;
    }
    if (this.currPoolSocket) {
      if (this.flags.verbose) this.logger.log(`Closing ${  this.poolLabel()  } pool socket`);
      this.currPoolSocket.destroy();
    }
    if (!this.flags.quiet) this.logger.log(`Connected to ${  this.config.pools[poolNum]  } pool`);
    if (!this.currPoolSocket && this.minerServer.socket) {
      this.logger.log(`Pool (${  this.config.pools[poolNum]  }) <-> miner link was established due to new pool connection`);
    }
    this.currPoolNum = poolNum;
    this.currPoolSocket = poolSocket;
    this.ethProxyWork.clear();
  }

  poolNewMsg(json) {
    const nextJobAlgo = this.recordPoolMessage(json);
    if (nextJobAlgo !== null && !this.switchAlgo(nextJobAlgo)) return;
    if (!this.minerServer.socket) return;

    if (this.minerServer.protocol === "grin") {
      if (nextJobAlgo !== null) this.minerServer.write(this.minerServer.socket, grinJsonReply("getjobtemplate", this.currPoolLastJob));
      else this.forwardGrinPoolMessage(json);
      return;
    }
    if (this.minerServer.protocol === "ethproxy") {
      if (isEthProxyWorkResult(json)) this.ethProxyWork.remember(this.currPoolLastJob, json.result);
      if (!("method" in json) && "id" in json) this.minerServer.write(this.minerServer.socket, stringifyLine(json));
      return;
    }
    this.minerServer.write(this.minerServer.socket, stringifyLine(json));
    if (json.id === this.pendingEthSubscribeId) { this.pendingEthSubscribeId = null; this.schedulePendingEthFirstJob(); }
  }

  schedulePendingEthFirstJob() { if (this.pendingEthFirstJobTimer || !this.pendingEthFirstJob || this.pendingEthSubscribeId !== null) return; this.pendingEthFirstJobTimer = setTimeout(() => this.flushPendingEthFirstJob(), 250); }
  flushPendingEthFirstJob() { if (this.pendingEthFirstJobTimer) clearTimeout(this.pendingEthFirstJobTimer); this.pendingEthFirstJobTimer = null; const pending = this.pendingEthFirstJob; this.pendingEthFirstJob = null; this.pendingEthSubscribeId = null; this.delayNextEthFirstJob = false; if (pending && this.minerServer.socket === pending.socket) this.sendFirstJob(pending.json, pending.socket); }
  shouldSendEthTarget() { return this.currPoolLastTarget && (this.currAlgo !== "autolykos2" || this.currPoolLastTarget.method === "mining.set_difficulty"); }
  recordPoolMessage(json) {
    let nextJobAlgo = null;
    if ("method" in json) {
      if (json.method === "job") {
        const params = json.params && typeof json.params === "object" ? json.params : {};
        nextJobAlgo = normalizePoolAlgo(params.algo || DEFAULT_ALGO, params);
        this.currPoolLastJob = params;
      } else if (json.method === "mining.notify") {
        nextJobAlgo = normalizePoolAlgo(json.algo || (json.params && json.params.algo) || DEFAULT_ALGO, json.params);
        this.currPoolLastJob = json.params || [];
      } else if (json.method === "mining.set_target" || json.method === "mining.set_difficulty") {
        this.currPoolLastTarget = json;
      }
    } else if (json.result && typeof json.result === "object" && "id" in json.result) {
      this.currPoolMinerId = json.result.id;
      if (json.result.job) {
        nextJobAlgo = normalizePoolAlgo(json.result.job.algo || DEFAULT_ALGO, json.result.job);
        this.currPoolLastJob = json.result.job;
      }
    }
    return nextJobAlgo;
  }

  switchAlgo(nextJobAlgo) {
    if (!(nextJobAlgo in this.config.algos)) {
      this.logger.err(`Ignoring job with unknown algo ${  nextJobAlgo  } sent by the pool (${  this.poolLabel()  })`);
      return false;
    }
    if (this.currAlgo !== nextJobAlgo) this.lastAlgoChangeTime = Date.now();
    this.currAlgo = nextJobAlgo;
    const nextMiner = this.config.algos[nextJobAlgo];
    if (!this.currMiner || this.currMiner !== nextMiner) {
      this.minerServer.setCurrent(null);
      if (!this.flags.quiet) this.logger.log(`Starting miner '${  nextMiner  }' to process new ${  nextJobAlgo  } algo`);
      this.currMiner = nextMiner;
      this.replaceMiner(nextMiner);
    }
    return true;
  }

  forwardGrinPoolMessage(json) {
    const grinJson = Object.assign({}, json);
    if (grinJson.result && grinJson.result.status === "OK") {
      grinJson.method = "submit";
      grinJson.result = "ok";
    }
    this.minerServer.write(this.minerServer.socket, stringifyLine(grinJson));
  }

  poolErr(poolNum) {
    if (poolNum === 0 && this.currPoolNum) {
      if (!this.mainPoolCheckTimer) this.logger.err("[INTERNAL ERROR] Unexpected main_pool_check_timer state in pool_err");
      this.setMainPoolCheckTimer();
      return;
    }
    if (this.currPoolNum !== poolNum) this.logger.err("[INTERNAL ERROR] Unexpected pool_num in pool_err");
    if (this.currPoolSocket && this.minerServer.socket) this.logger.err(`Pool (${  this.poolLabel()  }) <-> miner link was broken due to pool socket error`);
    this.currPoolSocket = null;
    this.currPoolLastJob = null;
    this.currPoolMinerId = null;
    this.currPoolLastTarget = null;
    this.ethProxyWork.clear();
    this.currPoolNum++;
    if (this.currPoolNum >= this.config.pools.length) {
      if (this.flags.verbose) this.logger.log("Waiting 60 seconds before trying to connect to the same pools once again");
      this.currPoolNum = 0;
      this.poolReconnectTimer = setTimeout(() => this.connectPool(this.currPoolNum), this.options.reconnectDelayMs || 60 * 1000);
    } else {
      this.connectPool(this.currPoolNum);
    }
  }

  setMainPoolCheckTimer() {
    if (this.flags.verbose) this.logger.log("Will retry connection attempt to the main pool in 90 seconds");
    clearTimeout(this.mainPoolCheckTimer);
    this.mainPoolCheckTimer = setTimeout(() => this.connectPool(0), this.options.mainPoolRetryMs || 90 * 1000);
  }

  replaceMiner(nextMiner) {
    if (!nextMiner) return;
    if (!this.minerProc) {
      this.minerProc = this.startMinerProcess(nextMiner, (str) => this.printAllMessages(str));
      return;
    }
    if (this.nextMinerToRun === null) {
      this.nextMinerToRun = nextMiner;
      if (this.flags.verbose) this.logger.log(`Stopping '${  this.currMiner  }' miner`);
      this.minerProc.once("close", () => {
        const command = this.nextMinerToRun;
        this.nextMinerToRun = null;
        this.minerProc = this.startMinerProcess(command, (str) => this.printAllMessages(str));
      });
      this.isWantMinerKill = true;
      treeKill(this.minerProc.pid);
    } else {
      this.nextMinerToRun = nextMiner;
    }
  }

  startMinerProcess(cmd, outCb) {
    this.lastMinerHashrate = null;
    // NB: do NOT reset lastAlgoChangeTime here — switchAlgo sets it (mm.js:335) and the
    // 15-min hashrate-watchdog warmup grace reads it; nulling it on (re)start made that grace dead.
    this.isWantMinerKill = false;
    let proc;
    try {
      proc = startMiner(cmd, {
        logger: this.logger,
        minerStdin: this.flags.minerStdin,
        onOutput: outCb,
        verbose: this.flags.verbose,
      });
    } catch (error) {
      this.logger.err(`Failed to parse miner command '${  cmd  }': ${  error.message}`);
      return null;
    }
    proc.on("close", (code) => this.handleMinerProcessClose(cmd, code, outCb));
    return proc;
  }

  handleMinerProcessClose(cmd, code, outCb) {
    if (this.flags.verbose) {
      if (code) this.logger.err(`Miner '${  cmd  }' exited with nonzero code ${  code}`);
      else this.logger.log(`Miner '${  cmd  }' exited with zero code`);
    }
    if (this.currPoolSocket && !this.isWantMinerKill) {
      this.logger.log(`Restarting '${  cmd  }' miner that was closed unexpectedly`);
      this.minerProc = this.startMinerProcess(cmd, outCb);
    }
  }

  startWatchdogs() {
    if (this.config.watchdog) this.startSubmitWatchdog();
    if (this.config.hashrate_watchdog) this.startHashrateWatchdog();
  }

  startSubmitWatchdog() {
    if (this.flags.verbose) this.logger.log(`Starting miner watchdog timer (with ${  this.config.watchdog  } seconds max since last miner result)`);
    const timer = setInterval(() => {
      if (this.currPoolSocket) this.writePool({ jsonrpc: "2.0", id: "mm", method: "keepalived", params: {} });
      if (!this.currPoolSocket || !this.minerServer.socket || this.minerLastSubmitTime === null) return;
      const idleTime = (Date.now() - this.minerLastSubmitTime) / 1000;
      if (idleTime > this.config.watchdog) {
        this.logger.err(`No results from miner for more than ${  this.config.watchdog  } seconds. Restarting it...`);
        this.minerLastSubmitTime = Date.now();
        this.replaceMiner(this.currMiner);
      }
    }, this.options.watchdogIntervalMs || 60 * 1000);
    this.watchdogTimers.push(timer);
  }

  startHashrateWatchdog() {
    if (this.flags.verbose) this.logger.log(`Starting miner hashrate watchdog timer (with ${  this.config.hashrate_watchdog  }% min hashrate threshold)`);
    const timer = setInterval(() => {
      if (!this.currPoolSocket || !this.minerServer.socket || this.lastMinerHashrate === null) return;
      if (this.lastAlgoChangeTime && Date.now() - this.lastAlgoChangeTime < 15 * 60 * 1000) return;
      const minHashrate = localAlgoPerf(this.config, this.currAlgo) * this.config.hashrate_watchdog / 100;
      if (this.lastMinerHashrate < minHashrate) {
        this.logger.err(`Current miner hashrate ${  this.lastMinerHashrate  } is below minimum ${  minHashrate  } hashrate threshold. Restarting it...`);
        this.replaceMiner(this.currMiner);
      }
    }, this.options.watchdogIntervalMs || 60 * 1000);
    this.watchdogTimers.push(timer);
  }

  printAllMessages(str) {
    this.logger.miner(str);
    if (!this.config.hashrate_watchdog) return;
    forEachHashrate(str, this.currAlgo, (hashrate) => {
      this.lastMinerHashrate = hashrate;
    });
  }

  printMessages(str) { if (!this.flags.quiet) this.printAllMessages(str); }

  writePool(message) { if (this.currPoolSocket) writePoolSocket(this.currPoolSocket, message, this.logger, this.flags.debug); }
  poolLabel() { return this.config.pools[this.currPoolNum]; }
}

async function runCli(argv, options) {
  const app = new MultiMinerApp(argv.slice(2), options);
  const code = await app.run();
  if (typeof code === "number") process.exitCode = code;
  return code;
}

module.exports = {
  AGENT,
  MultiMinerApp,
  VERSION,
  runCli,
};

if (require.main === module) {
  runCli(process.argv).catch((error) => {
    const message = error && error.stack ? error.stack : String(error);
    process.stderr.write(`!!! ${  message  }\n`);
    process.exitCode = 1;
  });
}
