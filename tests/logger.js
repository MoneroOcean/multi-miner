"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");

const { Logger } = require("../src/logger");

describe("logger", () => {
  it("degrades instead of crashing when the log file cannot be written", () => {
    // A non-existent directory makes fs.appendFileSync throw ENOENT, mimicking a log
    // path that became unwritable at runtime. log()/err() run from timers and socket
    // handlers, so an unguarded throw would kill the long-running miner.
    const logger = new Logger({ log_file: "/no/such/dir/multi-miner-test.log" }, {});
    const errors = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (line) => { errors.push(String(line)); return true; };
    try {
      assert.doesNotThrow(() => logger.err("first failure"));
      assert.doesNotThrow(() => logger.err("second failure"));
    } finally {
      process.stderr.write = originalWrite;
    }
    // The write failure is surfaced once on stderr, not repeated per line.
    const failureNotices = errors.filter((line) => line.includes("Failed to write log file"));
    assert.equal(failureNotices.length, 1);
  });
});
