"use strict";

const { Transform } = require("node:stream");
const { spec } = require("node:test/reporters");

class SpacedSpecReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.pendingText = "";
    this.lastPrintedBlankLine = false;
    this.lastPrintedNonEmptyLine = "";
    this.reporter = spec();
    this.reporter.on("data", (chunk) => {
      this.push(this.rewriteText(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
    });
    this.reporter.on("error", (error) => {
      this.destroy(error);
    });
  }

  rewriteText(text) {
    this.pendingText += text;
    let output = "";
    let newlineIndex = this.pendingText.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.pendingText.slice(0, newlineIndex + 1);
      this.pendingText = this.pendingText.slice(newlineIndex + 1);
      const isSuiteLine = /^\s*▶ /.test(line);
      if (isSuiteLine && this.lastPrintedNonEmptyLine && !this.lastPrintedBlankLine) line = `\n${  line}`;
      if (line.trim()) {
        this.lastPrintedBlankLine = false;
        this.lastPrintedNonEmptyLine = line.trimEnd();
      } else {
        this.lastPrintedBlankLine = true;
      }
      output += line;
      newlineIndex = this.pendingText.indexOf("\n");
    }
    return output;
  }

  _transform(event, encoding, callback) {
    if (this.reporter.write(event, encoding)) return callback();
    this.reporter.once("drain", callback);
  }

  _flush(callback) {
    this.reporter.end();
    this.reporter.once("end", () => {
      if (this.pendingText) {
        let output = this.pendingText;
        if (/^\s*▶ /.test(output) && this.lastPrintedNonEmptyLine && !this.lastPrintedBlankLine) output = `\n${  output}`;
        this.push(output);
        this.pendingText = "";
      }
      callback();
    });
  }
}

module.exports = SpacedSpecReporter;
