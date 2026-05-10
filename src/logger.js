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
    const line = prefix + message + "\n";
    stream.write(line);
    this.append(line);
  }

  append(line) {
    if (this.config && this.config.log_file) fs.appendFileSync(this.config.log_file, line);
  }

  verbose(message) {
    if (this.flags.verbose) this.log(message);
  }
}

module.exports = {
  Logger,
};
