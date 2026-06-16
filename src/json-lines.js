"use strict";

function stringifyLine(value) {
  return JSON.stringify(value) + "\n";
}

function createJsonLineParser(onJson, onInvalid) {
  let buffer = "";

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
      if (!buffer.includes("\n")) return;
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
