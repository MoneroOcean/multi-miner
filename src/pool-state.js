"use strict";

const { DEFAULT_ALGO, normalizePoolAlgo } = require("./algorithms");
const { stringifyLine } = require("./json-lines");

function recordPoolMessage(app, json) {
  let nextJobAlgo = null;
  if ("method" in json) {
    if (json.method === "job") {
      const params = json.params && typeof json.params === "object" ? json.params : {};
      nextJobAlgo = normalizePoolAlgo(params.algo || DEFAULT_ALGO, params);
      app.currPoolLastJob = params;
    } else if (json.method === "mining.notify") {
      nextJobAlgo = normalizePoolAlgo(json.algo || (json.params && json.params.algo) || DEFAULT_ALGO, json.params);
      app.currPoolLastJob = json.params || [];
    } else if (json.method === "mining.set_target" || json.method === "mining.set_difficulty") {
      app.currPoolLastTarget = json;
    }
  } else if (json.result && typeof json.result === "object" && "id" in json.result) {
    app.currPoolMinerId = json.result.id;
    if (json.result.job) {
      nextJobAlgo = normalizePoolAlgo(json.result.job.algo || DEFAULT_ALGO, json.result.job);
      app.currPoolLastJob = json.result.job;
    }
  }
  return nextJobAlgo;
}

function forwardGrinPoolMessage(app, json) {
  const grinJson = Object.assign({}, json);
  if (grinJson.result && grinJson.result.status === "OK") {
    grinJson.method = "submit";
    grinJson.result = "ok";
  }
  app.minerServer.write(app.minerServer.socket, stringifyLine(grinJson));
}

module.exports = {
  forwardGrinPoolMessage,
  recordPoolMessage,
};
