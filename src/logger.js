"use strict";

const fs = require("fs");

class Logger {
  constructor(config, flags) {
    this.config = config;
    this.flags = flags || {};
  }

  log(message) {
    this.write(process.stdout, ">>> ", message);
  }

  err(message) {
    this.write(process.stderr, "!!! ", message);
  }

  miner(message) {
    process.stdout.write(message);
    this.append(message);
  }

  write(stream, prefix, message) {
    const line = `${prefix + message  }\n`;
    stream.write(line);
    this.append(line);
  }

  append(line) {
    if (!this.config || !this.config.log_file) return;
    try {
      fs.appendFileSync(this.config.log_file, line);
    } catch (error) {
      // log()/err()/miner() run from timer callbacks and socket handlers; an
      // unguarded appendFileSync throw (disk full, log path removed/unwritable,
      // read-only remount, NFS error) would become an uncaught exception and kill
      // the long-running miner. Degrade to stderr instead so logging keeps working.
      if (!this.appendFailed) {
        this.appendFailed = true;
        process.stderr.write(`!!! Failed to write log file '${this.config.log_file}': ${error.message}\n`);
      }
    }
  }

  verbose(message) {
    if (this.flags.verbose) this.log(message);
  }
}

module.exports = {
  Logger,
};
