#!/usr/bin/env node
"use strict";

const { runBenchmarkRuns } = require("./src/benchmark");
const { createDefaultConfig, createDefaultFlags, parseArgs, printHelp, saveConfigFile } = require("./src/config");
const { formatDiagnostics, validateConfig } = require("./src/diagnostics");
const { forEachHashrate } = require("./src/hashrate");
const { Logger } = require("./src/logger");
const { checkMiners } = require("./src/miner-check");
const { MinerServer } = require("./src/miner-server");
const { gzipPearlSubmit } = require("./src/pearl");
const { connectPool, writePoolSocket } = require("./src/pool-client");
const { createEthProxyWorkTracker, detectMinerProtocol, ethProxySubmit, ethProxyWork, formatMinerReply, grinJsonReply, isEthProxyWorkResult, jsonError, jsonReply } = require("./src/protocol");
const { forwardGrinPoolMessage: forwardGrinMessage, recordPoolMessage: recordPoolState } = require("./src/pool-state");
const { startMiner, treeKill } = require("./src/process-manager");
const { stringifyLine } = require("./src/json-lines");
const { startWatchdogs: startWatchdogTimers } = require("./src/watchdogs");

const VERSION = "v5.2.0";
const AGENT = `Multi-Miner ${  VERSION}`;

// Auto-restart backoff for an unexpectedly-closed miner so a persistently-failing miner doesn't
// fork/exec storm. The consecutive-failure count resets once a miner has run longer than RESET_MS.
const MINER_RESTART_BACKOFF_MS = 2000;
const MINER_RESTART_BACKOFF_MAX_MS = 30000;
const MINER_RESTART_MAX = 5;
const MINER_RESTART_RESET_MS = 60000;

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
    this.currPoolJobAlgo = null;
    this.currPoolLoginResult = null;
    this.currPoolTargetAlgo = null;
    this.currPoolTargetPending = false;
    this.currPoolLastExtraNonce = null;
    this.currPoolExtraNonceAlgo = null;
    this.currPoolExtraNoncePending = false;
    this.currMinerSupportsMoNative = false;
    this.currMinerBooleanSubmit = false;
    // Pool request IDs are monotonic so delayed replies cannot be mistaken for a replacement child.
    this.pendingMinerRequests = new Map();
    this.nextMinerRequestId = 2;
    this.ethProxyWork = createEthProxyWorkTracker();
    this.pendingEthFirstJob = this.pendingEthSubscribeId = this.pendingEthFirstJobTimer = null;
    this.pendingMinerFirstJob = null;
    this.delayNextEthFirstJob = false;
    this.currPoolNum = 0;
    this.currMiner = null;
    this.currAlgo = null;
    this.benchmarkAlgo = null;
    this.lastAlgoChangeTime = null;
    this.lastMinerHashrate = null;
    this.mainPoolCheckTimer = null;
    this.poolReconnectTimer = null;
    this.minerProc = null;
    this.minerRestartTimer = null;
    this.minerRestartFailures = 0;
    this.lastMinerStartTime = 0;
    this.nextMinerToRun = null;
    this.isWantMinerKill = false;
    this.isStopping = false;
    this.stopPromise = null;
    this.minerLastSubmitTime = null;
    this.watchdogTimers = [];
    this.minerServer = new MinerServer({
      config: this.config,
      flags: this.flags,
      logger: this.logger,
      getPoolSocket: () => this.currPoolSocket,
      getPoolLabel: () => this.poolLabel(),
      getCurrentMiner: () => this.currMiner,
      getCurrentAlgo: () => this.benchmarkAlgo || this.currPoolJobAlgo,
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
    if (this.isStopping) return 0;
    if (!this.options.skipMinerCheck) await this.checkMiners(parsed);
    if (this.isStopping) return 0;
    const diagnostics = validateConfig(this.config);
    if (diagnostics.errors.length) {
      for (const error of diagnostics.errors) this.logger.err(`[FATAL] ${  error}`);
      await this.closeServer();
      return 1;
    }
    if (process.title !== this.config.proc_title) process.title = this.config.proc_title;
    await this.runBenchmarks();
    if (this.isStopping) return 0;
    this.main();
    return undefined;
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
        isStopping: () => this.isStopping,
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
        setBenchmarkAlgo: (algo) => { this.benchmarkAlgo = algo; },
        timeoutMs: this.options.benchmarkTimeoutMs,
        isStopping: () => this.isStopping,
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

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.isStopping = true;
    this.nextMinerToRun = null;
    this.isWantMinerKill = true;
    for (const timer of this.watchdogTimers) clearInterval(timer);
    this.watchdogTimers = [];
    clearTimeout(this.mainPoolCheckTimer);
    this.mainPoolCheckTimer = null;
    clearTimeout(this.poolReconnectTimer);
    this.poolReconnectTimer = null;
    clearTimeout(this.pendingEthFirstJobTimer);
    this.pendingEthFirstJobTimer = null;
    clearTimeout(this.minerRestartTimer);
    this.minerRestartTimer = null;
    if (this.currPoolSocket) this.currPoolSocket.destroy();
    this.currPoolSocket = null;
    this.ethProxyWork.clear();
    const proc = this.minerProc;
    this.stopPromise = (async () => {
      if (proc && proc.pid) {
        // The tree-kill callback confirms delivery, not child closure.
        await new Promise((resolve, reject) => {
          proc.once('close', resolve);
          // An exited child can still have descendant-owned output pipes to close.
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          treeKill(proc.pid, (error) => {
            if (!error) return;
            proc.removeListener('close', resolve);
            reject(error);
          });
        });
      }
      this.minerProc = null;
      await this.closeServer();
    })();
    return this.stopPromise;
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
      forward: (json, socket) => this.forwardMinerRequest(json, socket),
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
    this.currMinerSupportsMoNative = protocol === "default" && this.hasMinerExtension(json, "mo-native");
    const params = json && json.params && typeof json.params === "object" ? json.params : {};
    // Plain C29 clients omit advertised algo/algo-perf fields; capability-advertising clients use object ACKs.
    this.currMinerBooleanSubmit = protocol === "default" && !this.currMinerSupportsMoNative &&
      !Object.prototype.hasOwnProperty.call(params, "algo") &&
      !Object.prototype.hasOwnProperty.call(params, "algo-perf");
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
    if (this.hasPendingJobControls()) {
      // Wait for the next job to bind future controls, so they cannot pair with this cached job.
      this.pendingMinerFirstJob = { json, socket };
      return;
    }
    if (this.minerServer.protocol === "grin") {
      this.minerServer.write(socket, grinJsonReply("getjobtemplate", this.currPoolLastJob));
      return;
    }
    if (this.minerServer.protocol === "eth") {
      if (this.pendingEthSubscribeId !== null || this.delayNextEthFirstJob) { this.pendingEthFirstJob = { json, socket }; this.schedulePendingEthFirstJob(); return; }
      if (this.currAlgo === "pearlhash") {
        this.minerServer.write(socket, stringifyLine({ jsonrpc: "2.0", id: null, method: "mining.notify", params: this.currPoolLastJob }));
      } else if (Array.isArray(this.currPoolLastJob)) {
        const extraNonce = this.currentPoolExtraNonce();
        if (extraNonce) this.minerServer.write(socket, stringifyLine(this.poolControlForCurrentAlgo(extraNonce)));
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
    if (Array.isArray(this.currPoolLastJob)) {
      if (json && json.method === "login") this.currMinerSupportsMoNative = this.hasMinerExtension(json, "mo-native");
      if (!this.currMinerSupportsMoNative) {
        this.rejectUnsupportedNativeJob(json, socket);
        return;
      }
      this.sendNativeObjectFirstJob(json, socket);
      return;
    }
    const loginResult = this.currPoolLoginResult && typeof this.currPoolLoginResult === "object"
      ? Object.assign({}, this.currPoolLoginResult) : {};
    const extraNonce = this.currentPoolExtraNonce();
    if (extraNonce && Array.isArray(extraNonce.params)) {
      if (extraNonce.params.length > 0) loginResult.extra_nonce = extraNonce.params[0];
      if (extraNonce.params.length > 1) loginResult.extra_nonce2_size = extraNonce.params[1];
    }
    const reply = { jsonrpc: "2.0", error: null, result: Object.assign(loginResult, {
      id: this.currPoolMinerId,
      job: this.currPoolLastJob,
      status: "OK",
    }) };
    if ("id" in json) reply.id = json.id;
    this.minerServer.write(socket, stringifyLine(reply));
  }

  hasMinerExtension(json, extension) {
    const params = json && json.params;
    return Boolean(params && Array.isArray(params.extensions) && params.extensions.includes(extension));
  }

  hasPendingJobControls() {
    const activeAlgo = this.currAlgo || this.currPoolJobAlgo;
    return this.currPoolTargetPending || this.currPoolExtraNoncePending ||
      (this.currPoolLastTarget && this.currPoolTargetAlgo != null && this.currPoolTargetAlgo !== activeAlgo) ||
      (this.currPoolLastExtraNonce && this.currPoolExtraNonceAlgo != null && this.currPoolExtraNonceAlgo !== activeAlgo);
  }

  currentPoolExtraNonce() {
    const algo = this.currAlgo || this.currPoolJobAlgo;
    if (algo && this.currPoolExtraNonceAlgo && this.currPoolExtraNonceAlgo !== algo) return null;
    return this.currPoolLastExtraNonce;
  }

  rejectUnsupportedNativeJob(json, socket) {
    this.logger.err(`Native pool job requires the miner's mo-native extension`);
    this.minerServer.write(socket, jsonError(json, "Native pool job requires mo-native extension"));
    if (socket && typeof socket.end === "function") socket.end();
    if (this.minerServer.socket === socket) this.minerServer.setCurrent(null);
  }

  sendNativeObjectFirstJob(json, socket) {
    const poolLogin = this.currPoolLoginResult && typeof this.currPoolLoginResult === "object"
      ? this.currPoolLoginResult : {};
    const result = {
      id: this.currPoolMinerId || poolLogin.id,
      algo: this.currAlgo || this.currPoolJobAlgo,
      extensions: ["mo-native"],
      status: "OK",
    };
    const extraNonce = this.currentPoolExtraNonce();
    if (extraNonce && Array.isArray(extraNonce.params)) {
      if (extraNonce.params.length > 0) result.extra_nonce = extraNonce.params[0];
      if (extraNonce.params.length > 1) result.extra_nonce2_size = extraNonce.params[1];
    } else {
      if (poolLogin.extra_nonce !== undefined) result.extra_nonce = poolLogin.extra_nonce;
      if (poolLogin.extra_nonce2_size !== undefined) result.extra_nonce2_size = poolLogin.extra_nonce2_size;
    }
    const reply = { jsonrpc: "2.0", error: null, result };
    if (json && "id" in json) reply.id = json.id;
    this.minerServer.write(socket, stringifyLine(reply));
    if (extraNonce) this.minerServer.write(socket, stringifyLine(this.poolControlForCurrentAlgo(extraNonce)));
    if (this.currPoolLastTarget) this.minerServer.write(socket, stringifyLine(this.poolControlForCurrentAlgo(this.currPoolLastTarget)));
    this.minerServer.write(socket, stringifyLine({ jsonrpc: "2.0", method: "mining.notify", algo: result.algo, params: this.currPoolLastJob }));
  }

  poolControlForCurrentAlgo(message) {
    const algo = this.currAlgo || this.currPoolJobAlgo;
    if (!message || typeof message !== "object") return message;
    // MO-native carries an explicit nonce width; standard ETH/KawPow children infer it.
    // Keep the pool's prefix intact and retain Ergo/native-object width metadata.
    let adjustedMessage = message;
    if (this.minerServer.protocol === "eth" && (algo === "etchash" || algo === "kawpow") &&
        message.method === "mining.set_extranonce" && Array.isArray(message.params)) {
      adjustedMessage = Object.assign({}, message, { params: message.params.slice(0, 1) });
    }
    if (adjustedMessage.algo || algo == null) return adjustedMessage;
    return Object.assign({}, adjustedMessage, { algo });
  }

  poolMessageForMiner(json, nextJobAlgo) {
    if (this.minerServer.protocol === "eth" && this.currAlgo === "pearlhash" && nextJobAlgo !== null) {
      return { jsonrpc: "2.0", id: null, method: "mining.notify", params: this.currPoolLastJob };
    }
    if (json.method === "mining.set_extranonce" || json.method === "set_extranonce") {
      return this.poolControlForCurrentAlgo(json);
    }
    return json;
  }

  handleMinerSubscribe(json, socket) {
    if (this.minerServer.socket) {
      this.replaceMiner(this.currMiner);
      return;
    }
    if (this.currPoolSocket) {
      this.minerServer.setCurrent(socket, "eth");
      this.pendingEthFirstJob = null;
      this.delayNextEthFirstJob = true;
      this.pendingEthSubscribeId = this.forwardMinerRequest(json, socket);
      return;
    }
    this.logger.err(`No active pool (${  this.poolLabel()  }) to send subscribe job to the miner!`);
    this.minerServer.write(socket, jsonError(json, "No active Multi-Miner pool"));
  }
  handleMinerExtranonceSubscribe(json, socket) { this.minerServer.write(socket, jsonReply(json, true)); if (this.minerServer.protocol === "eth") this.schedulePendingEthFirstJob(); }

  forwardMinerRequest(json, socket) {
    if (!json || typeof json !== "object" || this.minerServer.socket !== socket || !this.currPoolSocket) return null;
    const hasId = Object.prototype.hasOwnProperty.call(json, "id");
    let message;
    try {
      message = gzipPearlSubmit(this.currAlgo, this.currPoolLastJob, json);
    } catch (error) {
      this.logger.err(`Rejecting Pearl submission locally: ${  error.message}`);
      this.minerServer.write(socket, jsonError(json, "Invalid Pearl proof"));
      return null;
    }
    let upstreamId = null;
    if (hasId) {
      upstreamId = this.nextMinerRequestId++;
      this.pendingMinerRequests.set(upstreamId, {
        originalId: json.id,
        socket,
        protocol: this.minerServer.protocol,
        algo: this.currAlgo || this.currPoolJobAlgo,
        booleanSubmit: this.currMinerBooleanSubmit,
        method: json.method,
      });
      message = Object.assign({}, message, { id: upstreamId });
    }
    this.writePool(message);
    if (json.method === "submit" || json.method === "mining.submit") this.minerServer.onSubmit();
    return upstreamId;
  }

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
    this.forwardMinerRequest(ethProxySubmit(json, this.config.user, job), socket);
  }
  connectPool(poolNum) {
    if (this.isStopping) return;
    connectPool({
      agent: AGENT,
      config: this.config,
      debug: this.flags.debug,
      logger: this.logger,
      onError: (num) => this.poolErr(num),
      onMessage: (json, socket) => this.poolNewMsg(json, socket),
      onOk: (num, socket) => this.poolOk(num, socket),
      poolNum,
      verbose: this.flags.verbose,
    });
  }

  poolOk(poolNum, poolSocket) {
    if (this.isStopping) {
      if (poolSocket) poolSocket.destroy();
      return;
    }
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
    // A new upstream session owns new nonce/login state. Reconnect the child socket,
    // not its process, instead of forwarding our login ACK to the old child session.
    const minerSocket = this.minerServer.socket;
    this.minerServer.setCurrent(null);
    if (minerSocket) minerSocket.destroy();
    this.currPoolNum = poolNum;
    this.currPoolSocket = poolSocket;
    this.resetPoolState();
  }

  resetPoolState() {
    this.currPoolLastJob = null;
    this.currPoolMinerId = null;
    this.currPoolLastTarget = null;
    this.currPoolJobAlgo = null;
    this.currPoolLoginResult = null;
    this.currPoolTargetAlgo = null;
    this.currPoolTargetPending = false;
    this.currPoolLastExtraNonce = null;
    this.currPoolExtraNonceAlgo = null;
    this.currPoolExtraNoncePending = false;
    this.currMinerSupportsMoNative = false;
    this.currMinerBooleanSubmit = false;
    this.pendingMinerRequests.clear();
    this.pendingMinerFirstJob = null;
    clearTimeout(this.pendingEthFirstJobTimer);
    this.pendingEthFirstJob = this.pendingEthSubscribeId = this.pendingEthFirstJobTimer = null;
    this.delayNextEthFirstJob = false;
    this.ethProxyWork.clear();
  }

  forwardPoolReply(json) {
    if (Object.prototype.hasOwnProperty.call(json, "method")) return false;
    const pendingRequest = this.pendingMinerRequests.get(json.id);
    if (pendingRequest) {
      this.pendingMinerRequests.delete(json.id);
      if (pendingRequest.socket !== this.minerServer.socket || pendingRequest.socket.destroyed) return true;
      this.minerServer.write(pendingRequest.socket, stringifyLine(formatMinerReply(json, pendingRequest)));
      if (json.id === this.pendingEthSubscribeId) {
        this.pendingEthSubscribeId = null;
        this.schedulePendingEthFirstJob();
      }
      return true;
    }
    return json.id !== 1 && !(this.minerServer.protocol === "ethproxy" && isEthProxyWorkResult(json));
  }

  replayPoolControls(nextJobAlgo, changedAlgo, targetPending, extraNoncePending) {
    if (this.currPoolLastExtraNonce && this.currPoolExtraNonceAlgo === nextJobAlgo &&
        (extraNoncePending || changedAlgo)) {
      this.minerServer.write(this.minerServer.socket, stringifyLine(this.poolControlForCurrentAlgo(this.currPoolLastExtraNonce)));
    }
    if (this.currPoolLastTarget && this.currPoolTargetAlgo === nextJobAlgo &&
        (targetPending || changedAlgo) &&
        (this.minerServer.protocol !== "eth" || this.shouldSendEthTarget())) {
      this.minerServer.write(this.minerServer.socket, stringifyLine(this.poolControlForCurrentAlgo(this.currPoolLastTarget)));
    }
  }

  isCurrentPoolFrame(sourceSocket) { return !this.isStopping && (!sourceSocket || sourceSocket === this.currPoolSocket); }
  waitingForEthSubscribe() { return this.minerServer.protocol === "eth" && this.pendingEthSubscribeId !== null; }

  poolNewMsg(json, sourceSocket) {
    if (!this.isCurrentPoolFrame(sourceSocket)) return;
    if (this.forwardPoolReply(json)) return;

    const previousPoolJobAlgo = this.currPoolJobAlgo;
    const previousTargetPending = this.currPoolTargetPending;
    const previousExtraNoncePending = this.currPoolExtraNoncePending;
    const previousSocket = this.minerServer.socket;
    const nextJobAlgo = this.recordPoolMessage(json);
    if (nextJobAlgo !== null && !this.switchAlgo(nextJobAlgo)) return;
    if (!this.minerServer.socket) return;
    // Subscribe replies must precede controls/jobs. The newest pool state is
    // already cached and sendFirstJob replays it after subscribe completes.
    if (this.waitingForEthSubscribe()) return;
    if (nextJobAlgo !== null && this.pendingMinerFirstJob) {
      const pending = this.pendingMinerFirstJob;
      this.pendingMinerFirstJob = null;
      if (pending.socket === this.minerServer.socket) {
        this.sendFirstJob(pending.json, pending.socket);
        return;
      }
    }

    const sameActiveChild = nextJobAlgo !== null && previousSocket === this.minerServer.socket;
    const isControl = json.method === "mining.set_target" || json.method === "mining.set_difficulty" ||
      json.method === "mining.set_extranonce" || json.method === "set_extranonce";
    if (isControl) {
      const controlAlgo = json.method === "mining.set_target" || json.method === "mining.set_difficulty"
        ? this.currPoolTargetAlgo : this.currPoolExtraNonceAlgo;
      if (controlAlgo == null || controlAlgo !== this.currAlgo) return;
    }

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
    if (this.minerServer.protocol === "default" && Array.isArray(this.currPoolLastJob) && !this.currMinerSupportsMoNative) {
      this.logger.err(`Ignoring native ${  nextJobAlgo  } job because the connected miner did not negotiate mo-native`);
      return;
    }
    if (sameActiveChild) this.replayPoolControls(nextJobAlgo, previousPoolJobAlgo !== nextJobAlgo,
      previousTargetPending, previousExtraNoncePending);
    this.minerServer.write(this.minerServer.socket, this.poolMessageForMiner(json, nextJobAlgo));
  }

  schedulePendingEthFirstJob() { if (this.pendingEthFirstJobTimer || !this.pendingEthFirstJob || this.pendingEthSubscribeId !== null) return; this.pendingEthFirstJobTimer = setTimeout(() => this.flushPendingEthFirstJob(), 250); }
  flushPendingEthFirstJob() { if (this.pendingEthFirstJobTimer) clearTimeout(this.pendingEthFirstJobTimer); this.pendingEthFirstJobTimer = null; const pending = this.pendingEthFirstJob; this.pendingEthFirstJob = null; this.pendingEthSubscribeId = null; this.delayNextEthFirstJob = false; if (pending && this.minerServer.socket === pending.socket) this.sendFirstJob(pending.json, pending.socket); }
  shouldSendEthTarget() { return this.currPoolLastTarget && (this.currAlgo !== "autolykos2" || this.currPoolLastTarget.method === "mining.set_difficulty"); }
  recordPoolMessage(json) { return recordPoolState(this, json); }

  switchAlgo(nextJobAlgo) {
    if (!(nextJobAlgo in this.config.algos)) {
      this.logger.err(`Ignoring job with unknown algo ${  nextJobAlgo  } sent by the pool (${  this.poolLabel()  })`);
      return false;
    }
    if (this.currAlgo !== nextJobAlgo) this.lastAlgoChangeTime = Date.now();
    this.currAlgo = nextJobAlgo;
    const nextMiner = this.config.algos[nextJobAlgo];
    if (!this.currMiner || this.currMiner !== nextMiner) {
      this.pendingMinerRequests.clear();
      this.pendingMinerFirstJob = null;
      this.minerServer.setCurrent(null);
      if (!this.flags.quiet) this.logger.log(`Starting miner '${  nextMiner  }' to process new ${  nextJobAlgo  } algo`);
      this.currMiner = nextMiner;
      this.replaceMiner(nextMiner);
    }
    return true;
  }

  forwardGrinPoolMessage(json) { forwardGrinMessage(this, json); }

  poolErr(poolNum) {
    if (this.isStopping) return;
    if (poolNum === 0 && this.currPoolNum) {
      if (!this.mainPoolCheckTimer) this.logger.err("[INTERNAL ERROR] Unexpected mainPoolCheckTimer state in poolErr");
      this.setMainPoolCheckTimer();
      return;
    }
    if (this.currPoolNum !== poolNum) this.logger.err("[INTERNAL ERROR] Unexpected poolNum in poolErr");
    if (this.currPoolSocket && this.minerServer.socket) this.logger.err(`Pool (${  this.poolLabel()  }) <-> miner link was broken due to pool socket error`);
    this.currPoolSocket = null;
    this.resetPoolState();
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
    if (this.isStopping || !nextMiner) return;
    // A deliberate algo change is a fresh context — clear crash-loop backoff state so a paused
    // auto-restart recovers.
    this.minerRestartFailures = 0;
    if (!this.minerProc) {
      this.minerProc = this.startMinerProcess(nextMiner, (str) => this.printAllMessages(str));
      return;
    }
    if (this.nextMinerToRun === null) {
      this.nextMinerToRun = nextMiner;
      if (this.flags.verbose) this.logger.log(`Stopping '${  this.currMiner  }' miner`);
      this.minerProc.once("close", () => {
        if (this.isStopping) {
          this.nextMinerToRun = null;
          return;
        }
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
    if (this.isStopping) return null;
    this.lastMinerHashrate = null;
    // A new start (auto-restart, algo change, or initial) supersedes any pending backoff restart.
    clearTimeout(this.minerRestartTimer);
    this.minerRestartTimer = null;
    this.lastMinerStartTime = Date.now();
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
    // Startup checks, benchmarks and live mining all own the same child slot.
    this.minerProc = proc;
    proc.on("close", (code) => this.handleMinerProcessClose(cmd, code, outCb));
    return proc;
  }

  handleMinerProcessClose(cmd, code, outCb) {
    if (this.flags.verbose) {
      if (code) this.logger.err(`Miner '${  cmd  }' exited with nonzero code ${  code}`);
      else this.logger.log(`Miner '${  cmd  }' exited with zero code`);
    }
    // The process is dead; clear the handle so replaceMiner doesn't attach once('close') to a proc
    // that already emitted 'close' (which would never fire and wedge miner startup).
    this.minerProc = null;
    if (this.isStopping) return;
    if (!this.currPoolSocket || this.isWantMinerKill) return;
    // Backoff + cap so a persistently-failing miner doesn't restart-storm. A miner that ran longer
    // than the reset window was a transient glitch, not a crash loop, so reset the failure count.
    if (Date.now() - this.lastMinerStartTime > MINER_RESTART_RESET_MS) this.minerRestartFailures = 0;
    this.minerRestartFailures += 1;
    if (this.minerRestartFailures > MINER_RESTART_MAX) {
      this.logger.err(`Miner '${  cmd  }' failed ${  this.minerRestartFailures  } times in a row; pausing auto-restart until the next algo change or pool reconnect`);
      return;
    }
    const delay = Math.min(this.minerRestartFailures * MINER_RESTART_BACKOFF_MS, MINER_RESTART_BACKOFF_MAX_MS);
    this.logger.log(`Restarting '${  cmd  }' miner (attempt ${  this.minerRestartFailures  }) in ${  delay  }ms`);
    this.minerRestartTimer = setTimeout(() => {
      this.minerRestartTimer = null;
      if (!this.currPoolSocket || this.isWantMinerKill) return;
      this.minerProc = this.startMinerProcess(cmd, outCb);
    }, delay);
  }

  startWatchdogs() { startWatchdogTimers(this); }

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
  const removeSignals = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
  const stop = () => {
    app.stop().then(removeSignals, () => {
      process.exitCode = 1;
      app.logger.err('Failed to stop the miner cleanly');
      removeSignals();
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const code = await app.run();
    if (typeof code === 'number') {
      process.exitCode = code;
      removeSignals();
    }
    return code;
  } catch (error) {
    await app.stop().finally(removeSignals);
    throw error;
  }
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
