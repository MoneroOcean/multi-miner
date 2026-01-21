#!/usr/bin/env node

// Meta Miner: adding algo switching support to *any* stratum miner
// Algo switching is supported by https://moneroocean.stream mining pool

// Copyright 2018 MoneroOcean <https://github.com/MoneroOcean>, <support@moneroocean.stream>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

"use strict";

// *****************************************************************************
// *** DEPENDECIES                                                           ***
// *****************************************************************************

const fs            = require('fs');
const net           = require('net');
const tls           = require('tls');
const path          = require('path');
const child_process = require('child_process');

// *****************************************************************************
// *** CONSTS                                                                ***
// *****************************************************************************

const VERSION      = "v4.6";
const DEFAULT_ALGO = "rx/0"; // this is algo that is assumed to be sent by pool if its job does not contain algo stratum extension
const AGENT        = "Meta Miner " + VERSION;

// [multiplier, nr benchmark prints, regex]
// the multiplier is for supporting hashrate prints in different units
// the nr benchmark prints is to make sure hashrate has stabilized before snapping the benchmark value
const hashrate_regexes = [
  [1,       1, /\[[^\]]+\] speed 2.5s\/60s\/15m [\d\.]+ ([\d\.]+)\s/],       // for old xmrig
  [1,       1, /\[[^\]]+\] speed 10s\/60s\/15m [\d\.n/a]+ ([\d\.]+)\s/],     // for new xmrig
  [1,       1, /\s+miner\s+speed 10s\/60s\/15m [\d\.n/a]+ ([\d\.]+)\s/],     // for xmrig v6+
  [1,       1, /Totals \(ALL\):\s+[\d\.]+\s+([1-9]\d*\.\d+|0\.[1-9]\d*)\s/], // xmr-stak
  [1,       1, /Total Speed: ([\d\.]+) H\/s,/],                              // claymore
  [1,       1, /\(Avr ([\d\.]+)H\/s\)/],                                     // CryptoDredge
  [1e3,     3, /Total[^:]+:\s*([\d\.]+)\s*kh\/s/],                           // TeamRedMiner variant 1 (kh/s)
  [1,       3, /Total[^:]+:\s*([\d\.]+)\s*h\/s/],                            // TeamRedMiner variant 2 (h/s)
  [1,       1, /Mining at\s+([\d\.]+) gps/],                                 // tube4referenceMiner (use mode=rolling command line option)
  [1,       1, /mining at\s+([\d\.]+) gps/],                                 // SwapReferenceMiner (use mode=rolling command line option)
  [1,       2, /Total\s+:\s+([\d\.]+) gps/],                                 // MoneroVMiner
  [1,       2, /\|\s+\d+\s+\S*\s*([\d\.]+) G\/s.*\|\n\+/],                   // gminer
  [1000000, 2, /\|\s+\d+\s+\S*\s*([\d\.]+) MH\/s.*\|\n\+/],                  // gminer
  [1,       2, /\|\s+([\d\.]+) G\/s.*\|\n\+/],                               // gminer (2+ GPUs)
  [1000000, 2, /\|\s+([\d\.]+) MH\/s.*\|\n\+/],                              // gminer (2+ GPUs)
  [1,       3, /Average speed \(15s\): ([\d\.]+) g\/s/],                     // lolminer
  [1000000, 3, /Average speed \(15s\): ([\d\.]+) Mh\/s/],                    // lolminer
];

function algo_hashrate_factor(algo) {
  switch (algo) {
    case "kawpow": return 1 / 0x100000000;
    case "c29":    return 1 / 42;
    case "c29s":   return 1 / 32;
    case "c29b":   return 1 / 40;
    case "c29v":   return 1 / 16;
    default:       return 1;
  }
}

// main algos we bench for
const bench_algos = [
  "cn/r",
  "cn-lite/1",
  "cn-heavy/xhv",
  "cn-pico/trtl",
  "cn/ccx",
  "cn/gpu",
  "argon2/chukwa",
  "kawpow",
  "ghostrider",
  "astrobwt",
  "rx/0",
  "rx/graft",
  "rx/arq",
  "panthera",
  "autolykos2",
  "c29",
  "c29b",
  "c29s",
  "c29v",
  "ethash",
  "etchash",
  "k12",
];

// algo and their perf that can be derived from thier main algo perf
function bench_algo_deps(bench_algo, perf) {
  switch (bench_algo) {
    case "cn/ccx": return {
      "cn/ccx":        perf,
      "cn/0":          perf / 2
    };
    case "cn/r": return {
      "cn/1":          perf,
      "cn/2":          perf,
      "cn/r":          perf,
      "cn/rto":        perf,
      "cn/xao":        perf,
      "cn/fast":       perf * 2,
      "cn/half":       perf * 2,
      "cn/rwz":        perf / 3 * 4,
      "cn/zls":        perf / 3 * 4,
      "cn/double":     perf / 2,
    };
    case "cn-lite/1": return {
      "cn-lite/0":     perf,
      "cn-lite/1":     perf,
    };
    case "cn-heavy/xhv": return {
      "cn-heavy/xhv":  perf,
    };
    case "cn-pico/trtl": return {
      "cn-pico/trtl":  perf,
    };
    case "cn/gpu": return {
      "cn/gpu":        perf,
    };
    case "argon2/chukwa": return {
      "argon2/chukwa": perf,
    };
    case "astrobwt": return {
      "astrobwt":      perf,
    };
    case "kawpow": return {
      "kawpow":        perf,
    };
    case "rx/0": return {
      "rx/0":          perf,
      "rx/sfx":        perf,
    };
    case "rx/graft": return {
      "rx/graft":      perf,
    };
    case "rx/arq": return {
      "rx/arq":        perf,
    };
    case "panthera": return {
      "panthera":      perf,
    };
    case "autolykos2": return {
      "autolykos2":    perf,
    };
    case "c29": return {
      "c29":           perf,
    };
    case "c29b": return {
      "c29b":          perf,
    };
    case "c29s": return {
      "c29s":          perf,
    };
    case "c29v": return {
      "c29v":          perf,
    };
    case "ethash": return {
      "ethash":        perf,
    };
    case "etchash": return {
      "etchash":       perf,
    };
    case "k12": return {
      "k12":           perf,
    };
    case "ghostrider": return {
      "ghostrider":    perf,
    };
    default: return {};
  }
}

// *****************************************************************************
// *** CONFIG                                                                ***
// *****************************************************************************

let console_file = process.cwd() + "/mm.json";

let c = {
  proc_title: "meta-miner",
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

let is_quiet_mode     = false;
let is_verbose_mode   = false;
let is_no_config_save = false;
let is_debug          = false;
let is_miner_stdin    = false;

// *****************************************************************************
// *** WORKING STATE                                                         ***
// *****************************************************************************

let curr_miner_socket     = null;
let curr_miner_protocol   = "default"; // curr_miner_socket communication protocol that can be "default", "grin" or "eth"
let curr_pool_socket      = null;
let curr_pool_last_job    = null;
let curr_pool_miner_id    = null;
let curr_pool_last_target = null;
let curr_miner            = null;
let next_miner_to_run     = null; // here we store miner command line that will be run after current miner is stopped or null if no miner is being stopped now
let curr_pool_num         = 0;
let last_miner_hashrate   = null;
let is_want_miner_kill    = false; // true if we want to kill miner (otherwise it is restart if closed without a reason)
let curr_algo             = null;
let last_algo_change_time = null;

let main_pool_check_timer  = null;
let miner_proc             = null;
let miner_login_cb         = null;
let miner_get_first_job_cb = null;
let miner_subscribe_cb     = null;
let miner_last_submit_time = null;

// *****************************************************************************
// *** FUNCTIONS                                                             ***
// *****************************************************************************

// *** inlined from tree_kill module

function tree_kill(pid, signal, callback) {
    var tree = {};
    var pidsToProcess = {};
    tree[pid] = [];
    pidsToProcess[pid] = 1;

    if (typeof signal === 'function' && callback === undefined) {
      callback = signal;
      signal = undefined;
    }

    switch (process.platform) {
    case 'win32':
        child_process.exec('taskkill /pid ' + pid + ' /T /F', {}, callback);
        break;
    case 'darwin':
        buildProcessTree(pid, tree, pidsToProcess, function (parentPid) {
          return child_process.spawn('pgrep', ['-P', parentPid]);
        }, function () {
            killAll(tree, signal, callback);
        });
        break;
    default: // Linux
        buildProcessTree(pid, tree, pidsToProcess, function (parentPid) {
          return child_process.spawn('ps', ['-o', 'pid', '--no-headers', '--ppid', parentPid]);
        }, function () {
            killAll(tree, signal, callback);
        });
        break;
    }
};

function killAll (tree, signal, callback) {
    var killed = {};
    try {
        Object.keys(tree).forEach(function (pid) {
            tree[pid].forEach(function (pidpid) {
                if (!killed[pidpid]) {
                    killPid(pidpid, signal);
                    killed[pidpid] = 1;
                }
            });
            if (!killed[pid]) {
                killPid(pid, signal);
                killed[pid] = 1;
            }
        });
    } catch (err) {
        if (callback) {
            return callback(err);
        } else {
            throw err;
        }
    }
    if (callback) {
        return callback();
    }
}

function killPid(pid, signal) {
    try {
        process.kill(parseInt(pid, 10), signal);
    }
    catch (err) {
        if (err.code !== 'ESRCH') throw err;
    }
}

function buildProcessTree(parentPid, tree, pidsToProcess, spawnChildProcessesList, cb) {
    var ps = spawnChildProcessesList(parentPid);
    var allData = '';
    ps.stdout.on('data', function (data) {
        var data = data.toString('ascii');
        allData += data;
    });

    var onClose = function (code) {
        delete pidsToProcess[parentPid];

        if (code != 0) {
            // no more parent processes
            if (Object.keys(pidsToProcess).length == 0) {
                cb();
            }
            return;
        }

        allData.match(/\d+/g).forEach(function (pid) {
          pid = parseInt(pid, 10);
          tree[parentPid].push(pid);
          tree[pid] = [];
          pidsToProcess[pid] = 1;
          buildProcessTree(pid, tree, pidsToProcess, spawnChildProcessesList, cb);
        });
    };

    ps.on('close', onClose);
}

// *** Console/log output

function log(msg) {
  console.log(">>> " + msg);
  if (c.log_file) fs.appendFileSync(c.log_file, ">>> " + msg + "\n");
}

function err(msg) {
  console.error("!!! " + msg);
  if (c.log_file) fs.appendFileSync(c.log_file, "!!! " + msg + "\n");
}

function print_all_messages(str) {
  process.stdout.write(str);
  if (c.log_file) fs.appendFileSync(c.log_file, str);
  if (c.hashrate_watchdog) {
    const str2 = str.replace(/\x1b\[[0-9;]*m/g, ""); // remove all colors
    for (let i in hashrate_regexes) {
      const hashrate_regex = hashrate_regexes[i];
      const m = str2.match(hashrate_regex[2]);
      if (m) last_miner_hashrate = parseFloat(m[1]) * hashrate_regex[0] * algo_hashrate_factor(curr_algo);
    }
  }
}

function print_messages(str) {
  if (!is_quiet_mode) print_all_messages(str);
}

// *** Miner socket processing

function set_curr_miner(socket, protocol) {
   curr_miner_socket   = socket;
   curr_miner_protocol = protocol ? protocol : "default";
}

function grin_json_reply(method, result) {
  return JSON.stringify({jsonrpc: "2.0", method: method, result: result}) + "\n";
}

function json_reply(json, result) {
  return JSON.stringify({jsonrpc: "2.0", id: json.id, error: null, result: result}) + "\n";
}

function miner_socket_write(miner_socket, message) {
  if (is_debug) log("Meta-Miner message to miner: " + message);
  miner_socket.write(message);
}

function pool_socket_write(pool_socket, message) {
  if (is_debug) log("Meta-Miner message to pool: " + message);
  pool_socket.write(message);
}

let miner_server = net.createServer(function (miner_socket) {
  if (curr_miner_socket) {
    err("Miner server on " + c.miner_host + ":" + c.miner_port + " port is already connected (please make sure you do not have other miner running)");
    miner_socket.end();
    return;
  }
  if (is_verbose_mode) log("Miner server on " + c.miner_host + ":" + c.miner_port + " port connected from " + miner_socket.remoteAddress);

  let miner_data_buff = "";

  miner_socket.on('data', function (msg) {
    miner_data_buff += msg;
    if (miner_data_buff.indexOf('\n') === -1) return;
    let messages = miner_data_buff.split('\n');
    let incomplete_line = miner_data_buff.slice(-1) === '\n' ? '' : messages.pop();
    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];
      if (message.trim() === '') continue;
      let json;
      try {
        json = JSON.parse(message);
      } catch (e) {
        err("Can't parse message from the miner: " + message);
        continue;
      }
      if (is_debug) log("Miner message: " + JSON.stringify(json));
      if (json.method === "login") {
        if (curr_miner_socket) { // need to restart miner in case of second login attempt to clean its internal state
          replace_miner(curr_miner);
        } else {
          miner_login_cb(json, miner_socket);
          if (curr_miner_protocol !== "grin") miner_get_first_job_cb(json, miner_socket);
        }
      } else if (json.method === "mining.authorize") {
        miner_login_cb(json, miner_socket);
        miner_get_first_job_cb(json, miner_socket);
      } else if (json.method === "getjobtemplate") { // only for grin
        miner_get_first_job_cb(json, miner_socket);
      } else if (json.method === "mining.subscribe") { // only for eth/raven
        miner_subscribe_cb(json, miner_socket);
      } else if (json.method === "mining.extranonce.subscribe") { // only for eth/raven
        miner_socket_write(miner_socket, json_reply(json, true));
      } else if (curr_pool_socket) {
        pool_socket_write(curr_pool_socket, JSON.stringify(json) + "\n");
        if (json.method === "submit" || json.method === "mining.submit") miner_last_submit_time = Date.now();
      } else if (json.method !== "keepalived") {
        err("Can't write miner reply to the pool since its socket is closed");
      }
    }
    miner_data_buff = incomplete_line;
  });
  miner_socket.on('end', function() {
    if (is_verbose_mode) log("Miner socket was closed");
    if (curr_pool_socket && curr_miner_socket) err("Pool (" + c.pools[curr_pool_num] + ") <-> miner link was broken due to closed miner socket");
    set_curr_miner(null);
  });
  miner_socket.on('error', function() {
    err("Miner socket error");
    if (curr_pool_socket && curr_miner_socket) err("Pool (" + c.pools[curr_pool_num] + ") <-> miner link was broken due to miner socket error");
    miner_socket.destroy();
    set_curr_miner(null);
  });
});

// *** Miner start helpers

function start_miner_raw(exe, args, out_cb) {
   const cmd = exe + " " + args.join(" ");
   if (is_verbose_mode) log("Starting miner: " + cmd);
   last_miner_hashrate = null;
   last_algo_change_time = null;
   is_want_miner_kill = false;
   let proc = child_process.spawn(exe, args, is_miner_stdin ? {stdio: ['inherit', 'pipe', 'pipe']} : {});

   proc.stdout.on('data', (data) => {
     if (out_cb) out_cb(`${data}`);
   });
   proc.stderr.on('data', (data) => {
     if (out_cb) out_cb(`${data}`);
   });
   proc.on('close', (code) => {
     if (is_verbose_mode) {
       if (code) err("Miner '" + cmd + "' exited with nonzero code " + code);
       else log("Miner '" + cmd + "' exited with zero code");
     }
     if (curr_pool_socket && !is_want_miner_kill) {
       log("Restarting '" + cmd + "' miner that was closed unexpectedly");
       miner_proc = start_miner_raw(exe, args, out_cb);
     }
   });
   proc.on('error', (error) => {
     err("Failed to start '" + cmd + "' miner: " + error);
   });
   return proc;
}

function start_miner(cmd, out_cb) {
   let args = cmd.match(/"[^"]+"|'[^']+'|\S+/g);
   let exe = args.shift();
   return start_miner_raw(exe, args, out_cb);
}

// *** Pool socket processing

function connect_pool(pool_num, pool_ok_cb, pool_new_msg_cb, pool_err_cb) {
  let pool_address_parts = c.pools[pool_num].split(/:/);

  const host = pool_address_parts[0];
  let   port = pool_address_parts[1];
  let m = port.match(/^(?:ssl|tls)(\d+)$/);
  let is_tls = false;
  if (m) { is_tls = true; port = m[1]; }
  let pool_socket = is_tls ? tls.connect(port, host, { rejectUnauthorized: false }) : net.connect(port, host);

  pool_socket.on('connect', function () {
    pool_socket_write(pool_socket, JSON.stringify({
      id: 1, jsonrpc: "2.0", method: "login", params: {
        login: c.user, pass: c.pass, agent: AGENT,
        algo: Object.keys(c.algos), "algo-perf": c.algo_perf, "algo-min-time": c.algo_min_time
      }
    }) + "\n");
  });

  let is_pool_ok = false;
  let pool_data_buff = "";

  pool_socket.on('data', function (msg) {
    pool_data_buff += msg;
    if (pool_data_buff.indexOf('\n') === -1) return;
    let messages = pool_data_buff.split('\n');
    let incomplete_line = pool_data_buff.slice(-1) === '\n' ? '' : messages.pop();
    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];
      if (message.trim() === '') continue;
      let json;
      try {
        json = JSON.parse(message);
      } catch (e) {
        err("Can't parse message from the pool (" + c.pools[pool_num] + "): " + message);
        continue;
      }
      if (is_debug) log("Pool message: " + JSON.stringify(json));
      if (!is_pool_ok && json.error === null) {
        pool_ok_cb(pool_num, pool_socket);
        is_pool_ok = true;
      }
      if (is_pool_ok) {
        if (json.id === "mm" && json.error === null && json.result instanceof Object && json.result.status === "KEEPALIVED") {
          if (is_verbose_mode) log("Keepalive reply recieved from the pool");
        } else {
          pool_new_msg_cb(json);
        }
      } else err("Ignoring pool (" + c.pools[pool_num] + ") message since pool not reported no errors yet: " + JSON.stringify(json));
    }
    pool_data_buff = incomplete_line;

  });

  pool_socket.on('end', function() {
    pool_socket.destroy();
    if (!is_pool_ok) {
      err("Pool (" + c.pools[pool_num] + ") socket closed before sending first job");
      pool_err_cb(pool_num);
    } else if (is_verbose_mode) log("Pool (" + c.pools[pool_num] + ") socket closed");
  });

  pool_socket.on('error', function() {
    err("Pool (" + c.pools[pool_num] + ") socket error");
    pool_socket.destroy();
    pool_err_cb(pool_num);
  });
}

// *** connect_pool function callbacks

function set_main_pool_check_timer() {
  if (is_verbose_mode) log("Will retry connection attempt to the main pool in 90 seconds");
  main_pool_check_timer = setTimeout(connect_pool, 90*1000, 0, pool_ok, pool_new_msg, pool_err);
}

function pool_ok(pool_num, pool_socket) {
  if (pool_num) {
    if (!main_pool_check_timer) set_main_pool_check_timer();
  } else {
    if (main_pool_check_timer) {
      if (is_verbose_mode) log("Stopped main pool connection attempts since its connection was established");
      clearTimeout(main_pool_check_timer);
      main_pool_check_timer = null;
    }
  }
  if (curr_pool_socket) {
    if (is_verbose_mode) log("Closing " + c.pools[curr_pool_num] + " pool socket");
    curr_pool_socket.destroy();
  }
  if (!is_quiet_mode) log("Connected to " + c.pools[pool_num] + " pool");
  if (!curr_pool_socket && curr_miner_socket) log("Pool (" + c.pools[pool_num] + ") <-> miner link was established due to new pool connection");
  curr_pool_num = pool_num;
  curr_pool_socket = pool_socket;
}

function replace_miner(next_miner) {
  if (miner_proc) {
    if (next_miner_to_run === null) {
      next_miner_to_run = next_miner;
      if (is_verbose_mode) log("Stopping '" + curr_miner + "' miner");
      miner_proc.on('close', (code) => {
        miner_proc = start_miner(next_miner_to_run, print_all_messages);
        next_miner_to_run = null;
      });
      is_want_miner_kill = true;
      tree_kill(miner_proc.pid);
    } else {
      next_miner_to_run = next_miner;
    }
  } else {
    miner_proc = start_miner(next_miner, print_all_messages);
  }
}

function pool_new_msg(json) {
  let next_job_algo = null;

  // record job updates and diff changes initiated by the pool
  if ("method" in json) switch (json.method) {
    case "job":
      next_job_algo = "params" in json && "algo" in json.params ? json.params.algo : DEFAULT_ALGO; // for usual jobs
      curr_pool_last_job = json.params;
      break;

    case "mining.notify":
      next_job_algo = "algo" in json ? json.algo : DEFAULT_ALGO; // for Raven/Eth jobs
      curr_pool_last_job = json.params;
      break;

    case "mining.set_target":
    case "mining.set_difficulty":
      curr_pool_last_target = json;

  } else if ("result" in json && json.result instanceof Object && "id" in json.result) { // record miner id in login pool reply and job if any
    curr_pool_miner_id = json.result.id;
    if ("job" in json.result) {
      next_job_algo = "algo" in json.result.job ? json.result.job.algo : DEFAULT_ALGO; // for the first job
      curr_pool_last_job = json.result.job;
    }
  }

  if (next_job_algo !== null) {
    if (!(next_job_algo in c.algos)) {
      err("Ignoring job with unknown algo " + next_job_algo + " sent by the pool (" + c.pools[curr_pool_num] + ")");
      return;
    }

    if (curr_algo != next_job_algo) last_algo_change_time = Date.now();
    curr_algo = next_job_algo;
    const next_miner = c.algos[next_job_algo];
    if (!curr_miner || curr_miner != next_miner) {
      set_curr_miner(null);
      if (!is_quiet_mode) log("Starting miner '" + next_miner + "' to process new " + next_job_algo + " algo");
      curr_miner = next_miner;
      replace_miner(next_miner);
    }
  }

  if (curr_miner_socket) switch (curr_miner_protocol) {
    case "grin":
      if (next_job_algo !== null) miner_socket_write(curr_miner_socket, grin_json_reply("getjobtemplate", curr_pool_last_job));
      else {
        let grin_json = json;
        if ("result" in grin_json && "status" in grin_json.result && grin_json.result.status === "OK") {
          grin_json.method = "submit";
          grin_json.result = "ok";
        }
        miner_socket_write(curr_miner_socket, JSON.stringify(grin_json) + "\n");
      }
      break;

    default:
      miner_socket_write(curr_miner_socket, JSON.stringify(json) + "\n");
  }
}

function pool_err(pool_num) {
  if (pool_num === 0 && curr_pool_num) { // this is main pool attempt error while we are on backup pool
    if (!main_pool_check_timer) err("[INTERNAL ERROR] Unexpected main_pool_check_timer state in pool_err");
    set_main_pool_check_timer();
    return;
  }
  if (curr_pool_num != pool_num) err("[INTERNAL ERROR] Unexpected pool_num in pool_err");
  if (curr_pool_socket && curr_miner_socket) err("Pool (" + c.pools[pool_num] + ") <-> miner link was broken due to pool socket error");
  curr_pool_socket      = null;
  curr_pool_last_job    = null;
  curr_pool_miner_id    = null;
  curr_pool_last_target = null;
  if (++ curr_pool_num >= c.pools.length) {
    if (is_verbose_mode) log("Waiting 60 seconds before trying to connect to the same pools once again");
    setTimeout(connect_pool, 60*1000, curr_pool_num = 0, pool_ok, pool_new_msg, pool_err);
  } else {
    connect_pool(curr_pool_num, pool_ok, pool_new_msg, pool_err);
  }
}

// *** Miner execution checks

function set_first_miner_user_pass(json) {
  if ("method" in json && "params" in json) {
    if (c.user === null) {
      if (json.method === "login" && (json.params instanceof Object) && "login" in json.params) {
        c.user = json.params.login;
      } else if (json.method === "mining.authorize" && Array.isArray(json.params) && json.params.length >= 1) {
        c.user = json.params[0];
      }
      if (is_verbose_mode) log("Setting pool user to '" + c.user + "'");
    }
    if (c.pass === null) {
      if (json.method === "login" && (json.params instanceof Object) && "pass" in json.params) {
        c.pass = json.params.pass;
      } else if (json.method === "mining.authorize" && Array.isArray(json.params) && json.params.length >= 2) {
        c.pass = json.params[1];
      }
      if (is_verbose_mode) log("Setting pool pass to '" + c.pass + "'");
    }
  }
}

function check_miners(smart_miners, miners, cb) {
  let check_miners = [];
  smart_miners.forEach(function (cmd) {
    check_miners.push(function(resolve) {
      let miner_proc = null;
      let timeout = setTimeout(function () {
        err("Miner '" + cmd + "' was not connected and will be ignored");
        miner_proc.on('close', (code) => { resolve(); });
        tree_kill(miner_proc.pid);
      }, 60*1000);
      miner_login_cb = function(json) {
        clearTimeout(timeout);
        set_first_miner_user_pass(json);
        if ("params" in json && (json.params instanceof Object) && "algo" in json.params && (json.params.algo instanceof Array)) {
          json.params.algo.forEach(function (algo) {
            if (is_verbose_mode) {
              if (c.algos[algo]) log("Setting " + algo + " algo from '" + c.algos[algo] + "' to '" + cmd + "' miner");
              else log("Setting " + algo + " algo to '" + cmd + "' miner");
            }
            c.algos[algo] = cmd;
            c.algos[algo.replace('cryptonight', 'cn')] = cmd;
            c.algos[algo.replace('randomx', 'rx')] = cmd;
          });
        } else {
          err("Miner '" + cmd + "' does not report any algo and will be ignored");
        }
        miner_proc.on('close', (code) => { resolve(); });
        tree_kill(miner_proc.pid);
      };
      miner_get_first_job_cb = function() {};
      miner_subscribe_cb = function(json, miner_socket) {
        miner_socket_write(miner_socket, json_reply(json, [ [ "mining.notify", "check", "EthereumStratum/1.0.0" ], "00", 7 ] ));
      };
      miner_proc = start_miner(cmd, print_messages);
    });
  });

  for (let algo in miners) {
    check_miners.push(function(resolve) {
      const cmd = miners[algo];
      let miner_proc = null;
      let timeout = setTimeout(function () {
        err("Miner '" + cmd + "' was not connected and will be ignored");
        miner_proc.on('close', (code) => { resolve(); });
        tree_kill(miner_proc.pid);
      }, 60*1000);
      miner_login_cb = function(json) {
        clearTimeout(timeout);
        set_first_miner_user_pass(json);
        if (is_verbose_mode) {
          if (c.algos[algo]) log("Setting " + algo + " algo from '" + c.algos[algo] + "' to '" + cmd + "' miner");
          else log("Setting " + algo + " algo to '" + cmd + "' miner");
        }
        c.algos[algo] = cmd;
        c.algos[algo.replace('cryptonight', 'cn')] = cmd;
        c.algos[algo.replace('randomx', 'rx')] = cmd;
        miner_proc.on('close', (code) => { resolve(); });
        tree_kill(miner_proc.pid);
      };
      miner_get_first_job_cb = function() {};
      miner_subscribe_cb = function(json, miner_socket) {
        miner_socket_write(miner_socket, json_reply(json, [ [ "mining.notify", "check", "EthereumStratum/1.0.0" ], "00", 7 ] ));
      };
      miner_proc = start_miner(cmd, print_messages);
    });
  }

  if (!is_quiet_mode && check_miners.length) log("Checking miner configurations (make sure they all configured to connect to " + c.miner_host + ":" + c.miner_port + " pool)");
  function next_miner_check() {
    if (check_miners.length === 0) return cb();
    const check_miner = check_miners.shift();
    check_miner(next_miner_check);
  }
  next_miner_check();
}

// *** Miner performance runs

function do_miner_perf_runs(cb) {
  let miner_perf_runs = [];
  for (let algo of bench_algos) {
    if (c.algo_perf[algo] || !(algo in c.algos)) continue;
    miner_perf_runs.push(function(resolve) {
      log("Checking miner performance for " + algo + " algo");
      const cmd = c.algos[algo];
      let miner_proc = null;
      let timeout = setTimeout(function () {
        err("Can't find performance data in '" + cmd + "' miner output");
        miner_proc.on('close', (code) => { resolve(); });
        tree_kill(miner_proc.pid);
      }, 5*60*1000);
      miner_login_cb = function(json, miner_socket) {
        curr_miner_protocol = json.method === "mining.authorize" ? "eth" : (json.id === "Stratum" || json.params.algorithm === "cuckarood29v" ? "grin" : "default");
        switch (curr_miner_protocol) {
          case "grin": miner_socket_write(miner_socket, grin_json_reply("login", "ok")); break;
          case "eth":  miner_socket_write(miner_socket, json_reply(json, true)); break;
        }
      };
      miner_get_first_job_cb = function(json, miner_socket) {
        switch (curr_miner_protocol) {
          case "grin": miner_socket_write(miner_socket, JSON.stringify({
            jsonrpc:  "2.0",
            id:       "Stratum",
            error:    null,
            method:   "getjobtemplate",
            result: {
              difficulty: 99999999,
              pre_pow:    "0c0ccbc9035e0000000026c1674f64401b00e6c50b681f21bb5d5bb07be6d4a9d12a8cb2b493c9c039fee90877199a9dc04dccd734cf9b4b30eae84d06b94da19614536f3a87b0fe65f201",
              algo:       "cuckaroo",
              edgebits:   29,
              proofsize:  algo === "c29" ? 42 : (algo === "c29s" ? 32 : (algo === "c29b" ? 40 : 48)),
              noncebytes: algo === "c29" ? 8 : 4,
              height:     0,
              job_id:     "100000000000000",
              id:         "100000000000000",
              status:     "OK",
            }
          }) + "\n");
          break;

          case "eth": switch (algo) {
            case "kawpow": miner_socket_write(miner_socket, JSON.stringify({
              jsonrpc:  "2.0",
              method:   "mining.notify",
              params: [
                "benchmark1", // job_id
                "4c38e8a5f7b2944d1e4274635d828519b97bc64a1f1c7896ecdbb139988aa0e8", // blob
                "accf7d1311da015b8dd41569c845c0ac739f0637707b8a117119fe1b5aeaa011", // seed hash
                "000000000002bd75000000000000000000000000000000000000000000000000", // target
                true,
                1500000,
                "1b0290a7",
              ]
            }) + "\n");
            break;

            case "ethash":
            case "etchash": miner_socket_write(miner_socket, JSON.stringify({
              jsonrpc:  "2.0",
              method:   "mining.set_difficulty",
              params: [
                1000000
              ],
            }) + "\n" + JSON.stringify({
              jsonrpc:  "2.0",
              method:   "mining.notify",
              params: [
                "benchmark1", // job_id
                "e79f0f63030bf691445c2b9d0266b24a9619e355194067f2ad2c73a8e0a26c65", // seed hash
                "feb4243b885cd1af5337979f5d81849335cab197b4993e5c61ea4b43b43dbbc6", // hash
                true,
              ]
            }) + "\n");
            break;

            case "autolykos2": miner_socket_write(miner_socket, JSON.stringify({
              jsonrpc:  "2.0",
              method:   "mining.notify",
              params: [
                "benchmark1", // job_id
                539302,       // height
                "920b5e8ed76f90e760469f04391ffaef3b5ecf1e1cb9363c449f490bc1564663", // hash
                "",
                "",
                2, // block version
                "82463468449557216163199121184281840485288878744226428810224501", // target
                "",
                true
              ]
            }) + "\n");
            break;

          }
          break;

          default: miner_socket_write(miner_socket, JSON.stringify({
            jsonrpc:  "2.0",
            id:       "id" in json ? json.id : 1,
            error:    null,
            result: {
              id:     "benchmark",
              status: "OK",
              job: {
                target:    "01000000",
                blob:      "7f7ffeeaa0db054f15eca39c843cb82c15e5c5a7743e06536cb541d4e96e90ffd31120b7703aa90000000076a6f6e34a9977c982629d8fe6c8b45024cafca109eef92198784891e0df41bc03",
                seed_hash: "0000000000000000000000000000000000000000000000000000000000000001",
                algo:      algo,
                height:    0,
                job_id:    "benchmark1",
                id:        "benchmark",
              }
            }
          }) + "\n");
        }
      };
      miner_subscribe_cb = function(json, miner_socket) {
        miner_socket_write(miner_socket, json_reply(json, [ [ "mining.notify", "benchmark", "EthereumStratum/1.0.0" ], "00", 7 ] ));
      };
      let nr_prints_needed = -1;
      let nr_prints_found = 0;
      miner_proc = start_miner(cmd, function(str) {
        print_messages(str);
        str = str.replace(/\x1b\[[0-9;]*m/g, ""); // remove all colors
        for (let i in hashrate_regexes) {
          const hashrate_regex = hashrate_regexes[i];
          const m = str.match(hashrate_regex[2]);
          if (m) {
            if (nr_prints_needed < 0) nr_prints_needed = hashrate_regex[1];
            const hashrate = parseFloat(m[1]) * hashrate_regex[0] * algo_hashrate_factor(algo);
            if (++nr_prints_found >= nr_prints_needed) {
              const algo_deps = bench_algo_deps(algo, hashrate);
              for (let algo_dep in algo_deps) {
                log("Setting performance for " + algo_dep + " algo to " + algo_deps[algo_dep]);
                c.algo_perf[algo_dep] = algo_deps[algo_dep];
              }
              miner_proc.on('close', (code) => { clearTimeout(timeout); resolve(); });
              tree_kill(miner_proc.pid);
              break;
            } else {
              log("Read performance for " + algo + " algo to " + hashrate + ", waiting for " +
                     (nr_prints_needed - nr_prints_found) + " more print(s).");
            }
          }
        }
      });
    });
  }

  function next_miner_perf_run() {
    if (miner_perf_runs.length === 0) return cb();
    const miner_perf_run = miner_perf_runs.shift();
    miner_perf_run(next_miner_perf_run);
  }
  next_miner_perf_run();
}

// *** Command line option handling

function print_help() {
  console.log("Usage: mm.js [<config_file.json>] [options]");
  console.log("Adding algo switching support to *any* stratum miner");
  console.log("<config_file.json> is file name of config file to load before parsing options (mm.json by default)");
  console.log("Config file and options should define at least one pool and miner:");
  console.log("Options:");
  console.log("\t--proc_title=<title> (-t):     \t<title> to use as the process.title (default: meta-miner)");
  console.log("\t--pool=<pool> (-p):            \t<pool> is in pool_address:pool_port format, where pool_port can be <port_number> or ssl<port_number>");
  console.log("\t--host=<hostname>:             \tdefines host that will be used for miner connections (localhost 127.0.0.1 by default)");
  console.log("\t--port=<number>:               \tdefines port that will be used for miner connections (3333 by default)");
  console.log("\t--user=<wallet> (-u):          \t<wallet> to use as pool user login (will be taken from the first miner otherwise)");
  console.log("\t--pass=<miner_id>:             \t<miner_id> to use as pool pass login (will be taken from the first miner otherwise)");
  console.log("\t--perf_<algo>=<hashrate>       \tSets hashrate for algo that is: " + bench_algos.join(", "));
  console.log("\t--algo_min_time=<seconds>      \tSets <seconds> minimum time pool should keep our miner on one algo (0 default, set higher for starting miners)");
  console.log("\t--miner=<command_line> (-m):   \t<command_line> to start smart miner that can report algo itself");
  console.log("\t--<algo>=<command_line>:       \t<command_line> to start miner for <algo> that can not report it itself");
  console.log("\t--watchdog=<seconds> (-w):     \trestart miner if is does not submit work for <seconds> (600 by default, 0 to disable)");
  console.log("\t--hashrate_watchdog=<percent>: \trestart miner if is hashrate dropped below <percent> value of of its expected hashrate (0 by default to disable)");
  console.log("\t--miner_stdin:                 \tenables stdin (input) in miner");
  console.log("\t--quiet (-q):                  \tdo not show miner output during configuration and also less messages");
  console.log("\t--verbose (-v):                \tshow more messages");
  console.log("\t--debug:                       \tshow pool and miner messages");
  console.log("\t--log=<file_name>:             \t<file_name> of output log");
  console.log("\t--no-config-save:              \tDo not save config file");
  console.log("\t--help (-help,-h,-?):          \tPrints this help text");
}

function parse_argv(cb) {
  let smart_miners = [];
  let miners = {};

  if (process.argv.length === 2) {
    if (!load_config_file()) {
      print_help();
      cb();
      return;
    }
  }

  process.argv.slice(2).forEach(function (val, index) {
    let m;
    if (index === 0) {
      if ((m = val.match(/^(.+\.json)$/)) && fs.existsSync(path.resolve(m[1]))) {
        console_file = m[1];
        load_config_file();
        return;
      } else {
        load_config_file();
      }
    }
    if (m = val.match(/^(?:--?help|-h|-\?)$/)) {
      print_help();
      process.exit(0);
    } else if (m = val.match(/^(?:--proc_title|-t)=(.+)$/)) {
      c.proc_title = m[1];
    } else if (m = val.match(/^(?:--quiet|-q)$/)) {
      is_quiet_mode = true;
    } else if (m = val.match(/^(?:--verbose|-v)$/)) {
      is_verbose_mode = true;
    } else if (m = val.match(/^--debug$/)) {
      is_debug = true;
    } else if (m = val.match(/^--no-config-save$/)) {
      is_no_config_save = true;
    } else if (m = val.match(/^--log=(.+)$/)) {
      if (is_verbose_mode) log("Setting log file name to " + m[1]);
      c.log_file = m[1];
    } else if (m = val.match(/^(?:--watchdog|w)=(.+)$/)) {
      const number = parseInt(m[1]);
      if (is_verbose_mode) log("Setting watchdog timeout to " + (number ? number : "disabled"));
      c.watchdog = number;
    } else if (m = val.match(/^--hashrate_watchdog=(.+)$/)) {
      const number = parseInt(m[1]);
      const percent = number > 100 ? 100 : number;
      if (is_verbose_mode) log("Setting hashrate watchdog timeout to " + (percent ? percent + "%" : "disabled"));
      c.hashrate_watchdog = percent;
    } else if (m = val.match(/^(?:--miner_stdin)$/)) {
      is_miner_stdin = true;
    } else if (m = val.match(/^(?:--pool|-p)=(.+)$/)) {
      if (m[1].split(/:/).length == 2) {
        if (is_verbose_mode) log("Added pool '" + m[1] + "' to the list of pools");
        if (c.pools.indexOf(m[1]) == -1) c.pools.push(m[1]);
      } else {
        err("Pool in invalid format '" + m[1] + "' is ignored, use <pool_address>:<pool_port> (or <pool_address>:ssl<pool_port>) format");
      }
    } else if (m = val.match(/^--host=(.+)$/)) {
      if (is_verbose_mode) log("Setting miner host to " + m[1]);
      c.miner_host = m[1];
    } else if (m = val.match(/^--port=([\d\.]+)$/)) {
      const number = parseInt(m[1]);
      if (is_verbose_mode) log("Setting miner port to " + number);
      c.miner_port = number;
    } else if (m = val.match(/^(?:--user|-u)=(.+)$/)) {
      if (is_verbose_mode) log("Setting pool user to " + m[1]);
      c.user = m[1];
    } else if (m = val.match(/^--algo_min_time=([\d\.]+)$/)) {
      const number = parseInt(m[1]);
      if (is_verbose_mode) log("Setting algo min time to " + number);
      c.algo_min_time = number;
    } else if (m = val.match(/^(?:--perf_([^=]+))=([\d\.]+)$/)) {
      if (m[1] in c.algo_perf) {
        const hashrate = parseFloat(m[2]);
        if (is_verbose_mode) log("Setting performance for " + m[1] + " algo to " + hashrate);
        c.algo_perf[m[1]] = hashrate;
      } else {
        err("Ignoring unknown algo " + m[1] + ". Please use one of these: " + bench_algos.join(", "));
      }
    } else if (m = val.match(/^(?:--pass)=(.+)$/)) {
      if (is_verbose_mode) log("Setting pool pass to '" + m[1] + "'");
      c.pass = m[1];
    } else if (m = val.match(/^(?:--miner|-m)=(.+)$/)) {
      if (is_verbose_mode) log("Adding smart miner: '" + m[1] + "'");
      smart_miners.push(m[1]);
    } else if (m = val.match(/^(?:--([^=]+))=(.+)$/)) {
      if (is_verbose_mode) log("Adding " + m[1] + " algo miner: " + m[2]);
      miners[m[1]] = m[2];
    } else {
      err("Ignoring unknown option '" + val + "'");
    }
  });

  miner_server.listen(c.miner_port, c.miner_host, function() {
    if (is_verbose_mode) log("Local miner server on " + c.miner_host + ":" + c.miner_port + " port started");
    check_miners(smart_miners, miners, cb);
  });
}

// *** Load/save config file

function load_config_file() {
  const config_file_abs = path.resolve(console_file);
  if (fs.existsSync(config_file_abs)) {
    if (is_verbose_mode) log("Loading " + config_file_abs + " config file");
    const c2 = require(config_file_abs);
    for (let x in c2) c[x] = c2[x];
    return true;
  } else {
    err("Config file " + config_file_abs + " does not exists");
    return false;
  }
}

function print_params() {
  let str = JSON.stringify(c, null, " ");
  if (is_verbose_mode) {
    log("");
    log("SETUP COMPLETE");
    log(str);
    log("");
    log("Saving " + console_file + " config file");
  }
  if (!is_no_config_save) fs.writeFile(console_file, str, function(error) { if (error) err("Error saving " + console_file + " file"); });
}

// *****************************************************************************
// *** MAIN PROGRAM                                                          ***
// *****************************************************************************

function main() {
  print_params();

  log("POOL USER: '" + c.user + "', PASS: '" + c.pass + "'");

  miner_login_cb = function(json, miner_socket) {
    if (curr_pool_socket && !curr_miner_socket) log("Pool (" + c.pools[curr_pool_num] + ") <-> miner link was established due to new miner connection");
    set_curr_miner(miner_socket, json.method === "mining.authorize" ? "eth" : (json.id === "Stratum" || json.params.algorithm === "cuckarood29v" ? "grin" : "default"));
    switch (curr_miner_protocol) {
      case "grin": miner_socket_write(miner_socket, grin_json_reply("login", "ok")); break;
      case "eth":  miner_socket_write(miner_socket, json_reply(json, true)); break;
    }
  };
  miner_get_first_job_cb = function(json, miner_socket) {
    if (curr_pool_last_job) {
      switch (curr_miner_protocol) {
        case "grin":
          miner_socket_write(miner_socket, grin_json_reply("getjobtemplate", curr_pool_last_job));
          break;

        case "eth":
          if (curr_pool_last_target && curr_algo != "autolykos2") {
            miner_socket_write(miner_socket, JSON.stringify(curr_pool_last_target) + "\n");
          }
          miner_socket_write(miner_socket, JSON.stringify({
            jsonrpc: "2.0",
            method:  "mining.notify",
            params:  curr_pool_last_job
          }) + "\n");
          break;

        default:
          let reply = { jsonrpc: "2.0", error: null, result: { id: curr_pool_miner_id, job: curr_pool_last_job, status: "OK" } };
          if ("id" in json) reply.id = json.id;
          miner_socket_write(miner_socket, JSON.stringify(reply) + "\n");
      }
    } else {
      err("No pool (" + c.pools[curr_pool_num] + ") job to send to the miner!");
    }
  };
  miner_subscribe_cb = function(json, miner_socket) {
    if (curr_miner_socket) { // need to restart miner in case of second login attempt to clean its internal state
      replace_miner(curr_miner);
    } else if (curr_pool_socket) {
      set_curr_miner(miner_socket, "eth");
      pool_socket_write(curr_pool_socket, JSON.stringify(json) + "\n");
    } else {
      err("No active pool (" + c.pools[curr_pool_num] + ") to send subscribe job to the miner!");
      miner_socket_write(miner_socket, JSON.stringify({
        jsonrpc:  "2.0",
        id:       json.id,
        error:    "No active meta-miner pool",
      }) + "\n");
    }
  };

  if (c.watchdog) {
    if (is_verbose_mode) log("Starting miner watchdog timer (with " + c.watchdog + " seconds max since last miner result)");
    setInterval(function () {
      if (curr_pool_socket) {
        if (is_verbose_mode) log("Sending keepalive message to the pool");
        pool_socket_write(curr_pool_socket, JSON.stringify({jsonrpc: "2.0", id: "mm", method: "keepalived", params: {}}) + "\n");
      }
      if (!curr_pool_socket || !curr_miner_socket || miner_last_submit_time === null) return;
      const miner_idle_time = (Date.now() - miner_last_submit_time) / 1000;
      if (miner_idle_time > c.watchdog) {
        err("No results from miner for more than " + c.watchdog + " seconds. Restarting it...");
        miner_last_submit_time = Date.now();
        replace_miner(curr_miner);
      }
    }, 60*1000);
  }

  if (c.hashrate_watchdog) {
    if (is_verbose_mode) log("Starting miner hashrate watchdog timer (with " + c.hashrate_watchdog + "% min hashrate threshold)");
    setInterval(function () {
      if (!curr_pool_socket || !curr_miner_socket || last_miner_hashrate === null) return;
      // there was perf change without miner restart so we need to wait for at least 15 minutes for hashrate to be correct
      if (last_algo_change_time && Date.now() - last_algo_change_time < 15*60*1000) return;
      const min_hashrate = c.algo_perf[curr_algo] * c.hashrate_watchdog / 100;
      if (last_miner_hashrate < min_hashrate) {
        err("Current miner hashrate " + last_miner_hashrate + " is below minimum " + min_hashrate + " hashrate threshold. Restarting it...");
        replace_miner(curr_miner);
      }
    }, 60*1000);
  }

  connect_pool(curr_pool_num = 0, pool_ok, pool_new_msg, pool_err);
};

process.title = 'meta-miner';
log("Meta Miner " + VERSION);

parse_argv(function() {
  if (c.pools.length == 0) {
    err("[FATAL] You must specify at least one pool");
    process.exit(1);
  }

  if (Object.keys(c.algos).length == 0) {
    err("[FATAL] You must specify at least one working miner");
    process.exit(1);
  }

  if(process.title !== c.proc_title) process.title = c.proc_title;
  do_miner_perf_runs(main);
});
