"use strict";

const fs = require("fs");
const path = require("path");
const { BENCH_ALGOS, expandAlgoPerf, isKnownPerfAlgo } = require("./algorithms");

const DEFAULT_CONFIG_FILE = "mm.json";

function createDefaultConfig() {
  return {
    proc_title: "mm",
    miner_host: "127.0.0.1",
    miner_port: 3333,
    pools: [],
    algos: {},
    algo_perf: {},
    algo_min_time: 0,
    user: null,
    pass: null,
    log_file: null,
    watchdog: 600,
    hashrate_watchdog: 0,
  };
}

function createDefaultFlags() {
  return {
    quiet: false,
    verbose: false,
    noConfigSave: false,
    debug: false,
    minerStdin: false,
    diagnostics: false,
  };
}

function printHelp(stream) {
  const out = stream || process.stdout;
  const lines = [
    "Usage: mm.js [<config_file.json>] [options]",
    "Multi-Miner: adding algo switching support to *any* stratum miner",
    "<config_file.json> is file name of config file to load before parsing options (mm.json by default)",
    "Config file and options should define at least one pool and miner:",
    "Options:",
    "\t--proc_title=<title> (-t):     \t<title> to use as the process.title (default: mm)",
    "\t--pool=<pool> (-p):            \t<pool> is in pool_address:pool_port format, where pool_port can be <port_number> or ssl<port_number>",
    "\t--host=<hostname>:             \tdefines host that will be used for miner connections (localhost 127.0.0.1 by default)",
    "\t--port=<number>:               \tdefines port that will be used for miner connections (3333 by default)",
    "\t--user=<wallet> (-u):          \t<wallet> to use as pool user login (will be taken from the first miner otherwise)",
    "\t--pass=<miner_id>:             \t<miner_id> to use as pool pass login (will be taken from the first miner otherwise)",
    `\t--perf_<algo>=<hashrate>       \tSets hashrate for algo that is: ${  BENCH_ALGOS.join(", ")}`,
    "\t--algo_min_time=<seconds>      \tSets <seconds> minimum time pool should keep our miner on one algo (0 default, set higher for starting miners)",
    "\t--miner=<command_line> (-m):   \t<command_line> to start smart miner that can report algo itself",
    "\t--<algo>=<command_line>:       \t<command_line> to start miner for <algo> that can not report it itself",
    "\t--watchdog=<seconds> (-w):     \trestart miner if it does not submit work for <seconds> (600 by default, 0 to disable)",
    "\t--hashrate_watchdog=<percent>: \trestart miner if its hashrate drops below <percent> of expected hashrate (0 by default to disable)",
    "\t--miner_stdin:                 \tenables stdin (input) in miner",
    "\t--diagnostics:                 \tprints config diagnostics and exits",
    "\t--quiet (-q):                  \tdo not show miner output during configuration and also less messages",
    "\t--verbose (-v):                \tshow more messages",
    "\t--debug:                       \tshow pool and miner messages",
    "\t--log=<file_name>:             \t<file_name> of output log",
    "\t--no-config-save:              \tDo not save config file",
    "\t--help (-help,-h,-?):          \tPrints this help text",
  ];
  out.write(`${lines.join("\n")  }\n`);
}

function loadConfigFile(fileName, config, logger) {
  const configFileAbs = path.resolve(fileName);
  if (!fs.existsSync(configFileAbs)) {
    if (logger) logger.err(`Config file ${  configFileAbs  } does not exist`);
    return false;
  }

  try {
    if (logger && logger.verbose) logger.verbose(`Loading ${  configFileAbs  } config file`);
    const parsed = JSON.parse(fs.readFileSync(configFileAbs, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    Object.assign(config, parsed);
    if (!config.pools) config.pools = [];
    if (!config.algos) config.algos = {};
    if (!config.algo_perf) config.algo_perf = {};
    return true;
  } catch (error) {
    if (logger) logger.err(`Can't load ${  configFileAbs  } config file: ${  error.message}`);
    return false;
  }
}

function saveConfigFile(fileName, config, logger) {
  const body = JSON.stringify(config, null, " ");
  fs.writeFile(fileName, body, (error) => {
    if (error && logger) logger.err(`Error saving ${  fileName  } file`);
  });
  return body;
}

function parsePoolAddress(pool) {
  if (typeof pool !== "string") return null;
  let host;
  let portPart;
  const bracketMatch = pool.match(/^\[([^\]]+)\]:(.+)$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    portPart = bracketMatch[2];
  } else {
    const parts = pool.split(":");
    if (parts.length !== 2) return null;
    host = parts[0];
    portPart = parts[1];
  }

  const portMatch = String(portPart).match(/^(ssl|tls)?(\d+)$/i);
  if (!host || !portMatch) return null;
  const port = Number.parseInt(portMatch[2], 10);
  if (port < 1 || port > 65535) return null;
  return { host, port, tls: Boolean(portMatch[1]), original: pool };
}

function numberValue(value, parser) { const number = parser(value, 10); return Number.isFinite(number) ? number : null; }

function addPool(config, pool, logger, verbose) {
  if (!parsePoolAddress(pool)) {
    if (logger) logger.err(`Pool in invalid format '${  pool  }' is ignored, use <pool_address>:<pool_port> (or <pool_address>:ssl<pool_port>) format`);
    return false;
  }
  if (!config.pools.includes(pool)) config.pools.push(pool);
  if (logger && verbose) logger.log(`Added pool '${  pool  }' to the list of pools`);
  return true;
}

function parseArgs(argv, opts) {
  const state = createParseState(opts);
  if (argv.length === 0) loadDefaultConfigForNoArgs(state);
  argv.forEach((value, index) => {
    if (tryLoadLeadingConfig(state, value, index)) return;
    parseOption(state, value);
  });
  return parseResult(state);
}

function createParseState(opts) {
  const options = opts || {};
  const cwd = options.cwd || process.cwd();
  return {
    config: options.config || createDefaultConfig(),
    configFile: path.resolve(cwd, DEFAULT_CONFIG_FILE),
    cwd,
    flags: options.flags || createDefaultFlags(),
    loadedConfig: false,
    logger: options.logger,
    miners: {},
    noArgsMissingDefault: false,
    smartMiners: [],
  };
}

function loadDefaultConfigForNoArgs(state) {
  state.loadedConfig = loadConfigFile(state.configFile, state.config, state.logger);
  state.noArgsMissingDefault = !state.loadedConfig;
}

function tryLoadLeadingConfig(state, value, index) {
  if (index !== 0) return false;
  const match = value.match(/^(.+\.json)$/);
  if (match && fs.existsSync(path.resolve(state.cwd, match[1]))) {
    state.configFile = path.resolve(state.cwd, match[1]);
    state.loadedConfig = loadConfigFile(state.configFile, state.config, state.logger);
    return true;
  }
  if (!state.loadedConfig && !isHelpOption(value)) {
    state.loadedConfig = loadConfigFile(state.configFile, state.config, state.logger);
  }
  return false;
}

function parseOption(state, value) {
  if (isHelpOption(value)) {
    state.flags.help = true;
    return;
  }
  for (const handler of OPTION_HANDLERS) {
    const match = value.match(handler.regex);
    if (match) {
      handler.apply(state, match);
      return;
    }
  }
  if (state.logger) state.logger.err(`Ignoring unknown option '${  value  }'`);
}

const OPTION_HANDLERS = [
  option(/^(?:--proc_title|-t)=(.+)$/, (state, match) => { state.config.proc_title = match[1]; }),
  option(/^(?:--quiet|-q)$/, (state) => { state.flags.quiet = true; }),
  option(/^(?:--verbose|-v)$/, (state) => { state.flags.verbose = true; }),
  option(/^--debug$/, (state) => { state.flags.debug = true; }),
  option(/^--no-config-save$/, (state) => { state.flags.noConfigSave = true; }),
  option(/^--diagnostics$/, (state) => { state.flags.diagnostics = true; }),
  option(/^--log=(.+)$/, (state, match) => { state.config.log_file = match[1]; }),
  option(/^(?:--watchdog|-w)=(.+)$/, (state, match) => setInt(state.config, "watchdog", match[1])),
  option(/^--hashrate_watchdog=(.+)$/, (state, match) => setPercent(state.config, "hashrate_watchdog", match[1])),
  option(/^--miner_stdin$/, (state) => { state.flags.minerStdin = true; }),
  option(/^(?:--pool|-p)=(.+)$/, (state, match) => addPool(state.config, match[1], state.logger, state.flags.verbose)),
  option(/^--host=(.+)$/, (state, match) => { state.config.miner_host = match[1]; }),
  option(/^--port=(\d+)$/, (state, match) => { state.config.miner_port = Number.parseInt(match[1], 10); }),
  option(/^(?:--user|-u)=(.+)$/, (state, match) => { state.config.user = match[1]; }),
  option(/^--algo_min_time=([\d.]+)$/, (state, match) => { state.config.algo_min_time = Number.parseInt(match[1], 10); }),
  option(/^--perf_([^=]+)=([\d.]+)$/, (state, match) => applyPerfOption(state.config, match[1], match[2], state.logger, state.flags.verbose)),
  option(/^--pass=(.+)$/, (state, match) => { state.config.pass = match[1]; }),
  option(/^(?:--miner|-m)=(.+)$/, (state, match) => { state.smartMiners.push(match[1]); }),
  option(/^--([^=]+)=(.+)$/, (state, match) => { state.miners[match[1]] = match[2]; }),
];

function option(regex, apply) { return { regex, apply }; }

function setInt(object, key, value) {
  const number = numberValue(value, Number.parseInt);
  if (number !== null) object[key] = number;
}

function setPercent(object, key, value) {
  const number = numberValue(value, Number.parseInt);
  if (number !== null) object[key] = Math.max(0, Math.min(100, number));
}

function parseResult(state) {
  return {
    config: state.config,
    configFile: state.configFile,
    flags: state.flags,
    miners: state.miners,
    noArgsMissingDefault: state.noArgsMissingDefault,
    smartMiners: state.smartMiners,
  };
}

function applyPerfOption(config, algo, value, logger, verbose) {
  if (!isKnownPerfAlgo(algo)) {
    if (logger) logger.err(`Ignoring unknown algo ${  algo  }. Please use one of these: ${  BENCH_ALGOS.join(", ")}`);
    return false;
  }
  const hashrate = Number.parseFloat(value);
  if (!Number.isFinite(hashrate)) return false;
  const algos = expandAlgoPerf(config, algo, hashrate);
  if (logger && verbose) {
    for (const depAlgo of algos) logger.log(`Setting performance for ${  depAlgo  } algo to ${  config.algo_perf[depAlgo]}`);
  }
  return true;
}

function isHelpOption(value) { return /^(?:--?help|-h|-\?)$/.test(value); }

module.exports = {
  DEFAULT_CONFIG_FILE,
  addPool,
  applyPerfOption,
  createDefaultConfig,
  createDefaultFlags,
  loadConfigFile,
  parseArgs,
  parsePoolAddress,
  printHelp,
  saveConfigFile,
};
