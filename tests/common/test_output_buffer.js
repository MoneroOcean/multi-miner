"use strict";

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const buffered = [];
let flushed = false;
const shouldFlushBufferedOutput = process.env.NODE_TEST_FLUSH_BUFFERED_OUTPUT === "1";

function bufferConsole(method) {
  return (...args) => {
    buffered.push({ method, args });
  };
}

console.log = bufferConsole("log");
console.info = bufferConsole("info");
console.warn = bufferConsole("warn");
console.error = bufferConsole("error");
process.stdout.write = bufferPrefixedStreamWrite(originalStdoutWrite, "stdout");
process.stderr.write = bufferPrefixedStreamWrite(originalStderrWrite, "stderr");

function bufferPrefixedStreamWrite(originalWrite, streamName) {
  return (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk);
    if (/^(>>>|!!!) /.test(text)) {
      buffered.push({ method: streamName, args: [text] });
      if (typeof callback === "function") process.nextTick(callback);
      return true;
    }
    return originalWrite(chunk, encoding, callback);
  };
}

function flushBufferedOutput() {
  if (flushed || buffered.length === 0) return;
  flushed = true;

  originalConsole.error("");
  originalConsole.error("Suppressed debug output:");
  for (const entry of buffered) {
    if (entry.method === "stdout") originalStdoutWrite(...entry.args);
    else if (entry.method === "stderr") originalStderrWrite(...entry.args);
    else originalConsole[entry.method](...entry.args);
  }
}

process.on("exit", (code) => {
  if (shouldFlushBufferedOutput && code !== 0) flushBufferedOutput();
});
