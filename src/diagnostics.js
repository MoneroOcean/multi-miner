"use strict";

const { CURRENT_GPU_ALGOS } = require("./algorithms");
const { parsePoolAddress } = require("./config");

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(config.pools) || config.pools.length === 0) {
    errors.push("You must specify at least one pool");
  } else {
    config.pools.forEach((pool) => {
      if (!parsePoolAddress(pool)) errors.push(`Invalid pool address: ${  pool}`);
    });
  }

  if (!config.algos || Object.keys(config.algos).length === 0) {
    errors.push("You must specify at least one working miner");
  }

  if (!Number.isInteger(config.miner_port) || config.miner_port < 1 || config.miner_port > 65535) {
    errors.push("miner_port must be an integer from 1 to 65535");
  }

  if (config.algo_perf && typeof config.algo_perf === "object") {
    for (const [algo, value] of Object.entries(config.algo_perf)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        warnings.push(`Ignoring suspicious performance value for ${  algo  }: ${  value}`);
      }
    }
  }

  const gpuConfigured = CURRENT_GPU_ALGOS.filter((algo) => config.algos && config.algos[algo]);
  if (gpuConfigured.length === 0) {
    warnings.push(`No current MoneroOcean GPU algorithms are configured: ${  CURRENT_GPU_ALGOS.join(", ")}`);
  }

  return { errors, warnings };
}

function formatDiagnostics(config) {
  const result = validateConfig(config);
  const lines = ["Multi-Miner diagnostics"];
  for (const warning of result.warnings) lines.push(`warning: ${  warning}`);
  for (const error of result.errors) lines.push(`error: ${  error}`);
  if (result.errors.length === 0) lines.push("status: ok");
  return lines.join("\n");
}

module.exports = {
  formatDiagnostics,
  validateConfig,
};
