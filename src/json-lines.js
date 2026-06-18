"use strict";

// Cap a single un-terminated line so a peer that streams bytes without a newline
// (a MITM/abusive pool, or any client reaching a public miner port) cannot grow the
// parse buffer without bound and OOM the process. Stratum lines are tiny; 1 MiB is
// far above any legitimate frame. Past the cap the buffer is dropped and reported as
// invalid so the connection degrades instead of crashing the miner.
const MAX_LINE_BYTES = 1024 * 1024;

function stringifyLine(value) {
  return `${JSON.stringify(value)  }\n`;
}

function createJsonLineParser(onJson, onInvalid) {
  let buffer = "";
  // When a single line blows past the cap we drop it and stay in "discard" mode until
  // the next newline, so the abandoned garbage can never contaminate the following
  // legitimate frame; the parser resyncs cleanly at the next line boundary.
  let discarding = false;

  function handleLine(line) {
    const message = line.trim();
    if (!message) return;
    try {
      onJson(JSON.parse(message), message);
    } catch (error) {
      if (onInvalid) onInvalid(message, error);
    }
  }

  return {
    push(chunk) {
      buffer += chunk.toString();
      if (discarding) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) { buffer = ""; return; }
        discarding = false;
        buffer = buffer.slice(newlineIndex + 1);
      }
      if (!buffer.includes("\n")) {
        if (buffer.length > MAX_LINE_BYTES) {
          if (onInvalid) onInvalid("", new Error(`Line exceeded ${MAX_LINE_BYTES} bytes without a newline`));
          buffer = "";
          discarding = true;
        }
        return;
      }
      const lines = buffer.split("\n");
      // If the chunk ended on a newline the split leaves a trailing "" with no partial line to keep;
      // otherwise the last element is an incomplete line that must be carried over to the next chunk.
      buffer = buffer.endsWith("\n") ? "" : lines.pop();
      for (const line of lines) handleLine(line);
    },
  };
}

module.exports = {
  createJsonLineParser,
  stringifyLine,
};
