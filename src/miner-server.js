"use strict";

const net = require("net");
const { createJsonLineParser, stringifyLine } = require("./json-lines");
const { ethSubscribeResult, jsonReply } = require("./protocol");

class MinerServer {
  constructor(options) {
    this.config = options.config;
    this.logger = options.logger;
    this.flags = options.flags;
    this.getPoolSocket = options.getPoolSocket;
    this.getPoolLabel = options.getPoolLabel;
    this.getCurrentMiner = options.getCurrentMiner;
    this.replaceMiner = options.replaceMiner;
    this.onSubmit = options.onSubmit;
    this.handlers = {};
    this.socket = null;
    this.protocol = "default";
    this.server = net.createServer((minerSocket) => this.handleConnection(minerSocket));
  }

  setHandlers(handlers) {
    this.handlers = handlers || {};
  }

  listen(callback) {
    this.server.listen(this.config.miner_port, this.config.miner_host, callback);
  }

  close(callback) {
    this.server.close(callback);
  }

  setCurrent(socket, protocol) {
    this.socket = socket;
    this.protocol = protocol || "default";
  }

  write(socket, message) {
    const line = typeof message === "string" ? message : stringifyLine(message);
    if (this.flags.debug) this.logger.log("Multi-Miner message to miner: " + line.trimEnd());
    socket.write(line);
  }

  handleConnection(minerSocket) {
    if (this.socket) {
      this.logger.err("Miner server on " + this.config.miner_host + ":" + this.config.miner_port + " port is already connected (please make sure you do not have other miner running)");
      minerSocket.end();
      return;
    }
    if (this.flags.verbose) this.logger.log("Miner server on " + this.config.miner_host + ":" + this.config.miner_port + " port connected from " + minerSocket.remoteAddress);

    const parser = createJsonLineParser((json) => this.handleMessage(json, minerSocket), (message) => {
      this.logger.err("Can't parse message from the miner: " + message);
    });

    minerSocket.on("data", (msg) => parser.push(msg));
    minerSocket.on("end", () => this.handleClose("closed"));
    minerSocket.on("error", () => {
      this.logger.err("Miner socket error");
      minerSocket.destroy();
      this.handleClose("error");
    });
  }

  handleMessage(json, minerSocket) {
    if (this.flags.debug) this.logger.log("Miner message: " + JSON.stringify(json));
    if (json.method === "login") {
      this.handleLogin(json, minerSocket);
    } else if (json.method === "mining.authorize") {
      this.callHandler("login", json, minerSocket);
      this.callHandler("firstJob", json, minerSocket);
    } else if (json.method === "getjobtemplate") {
      this.callHandler("firstJob", json, minerSocket);
    } else if (json.method === "mining.subscribe") {
      this.callHandler("subscribe", json, minerSocket);
    } else if (json.method === "mining.extranonce.subscribe") {
      if (this.handlers.extranonceSubscribe) this.callHandler("extranonceSubscribe", json, minerSocket);
      else this.write(minerSocket, jsonReply(json, true));
    } else if (json.method === "eth_submitLogin") {
      this.callHandler("login", json, minerSocket);
    } else if (json.method === "eth_getWork") {
      this.callHandler("firstJob", json, minerSocket);
    } else if (json.method === "eth_submitWork") {
      this.callHandler("submitWork", json, minerSocket);
    } else if (json.method === "eth_submitHashrate" || json.method === "eth_mining") {
      this.write(minerSocket, jsonReply(json, true));
    } else {
      this.forwardMinerMessage(json);
    }
  }

  handleLogin(json, minerSocket) {
    if (this.socket) {
      this.replaceMiner(this.getCurrentMiner());
      return;
    }
    this.callHandler("login", json, minerSocket);
    if (this.protocol !== "grin") this.callHandler("firstJob", json, minerSocket);
  }

  forwardMinerMessage(json) {
    const poolSocket = this.getPoolSocket();
    if (poolSocket) {
      poolSocket.write(stringifyLine(json));
      if (json.method === "submit" || json.method === "mining.submit") this.onSubmit();
    } else if (json.method !== "keepalived") {
      this.logger.err("Can't write miner reply to the pool since its socket is closed");
    }
  }

  callHandler(name, json, minerSocket) {
    if (this.handlers[name]) this.handlers[name](json, minerSocket);
  }

  handleClose(reason) {
    if (this.flags.verbose) this.logger.log("Miner socket was " + reason);
    if (this.getPoolSocket() && this.socket) {
      this.logger.err("Pool (" + this.getPoolLabel() + ") <-> miner link was broken due to " + reason + " miner socket");
    }
    this.setCurrent(null);
  }
}

function benchmarkSubscribeReply(json, tag) {
  return jsonReply(json, ethSubscribeResult(tag));
}

module.exports = {
  MinerServer,
  benchmarkSubscribeReply,
};
