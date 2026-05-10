"use strict";

function isWhitespace(ch) {
  return /\s/.test(ch);
}

function shouldEscape(next, quote) {
  if (!next) return false;
  if (quote === "'") return next === "'" || next === "\\";
  if (quote === "\"") return next === "\"" || next === "\\";
  return isWhitespace(next) || next === "\"" || next === "'" || next === "\\";
}

function parseCommand(command) {
  if (Array.isArray(command)) return command.slice();
  if (typeof command !== "string") throw new TypeError("Command must be a string");

  const args = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "\\" && shouldEscape(next, quote)) {
      current += next;
      tokenStarted = true;
      i++;
      continue;
    }

    if ((ch === "\"" || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      tokenStarted = true;
      continue;
    }

    if (!quote && isWhitespace(ch)) {
      if (tokenStarted) args.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (quote) throw new Error("Unterminated quote in command line");
  if (tokenStarted) args.push(current);
  if (args.length === 0) throw new Error("Command line is empty");
  return args;
}

function splitCommand(command) {
  const args = parseCommand(command);
  return { exe: args[0], args: args.slice(1) };
}

function formatCommand(exe, args) {
  return [exe].concat(args || []).join(" ");
}

module.exports = {
  formatCommand,
  parseCommand,
  splitCommand,
};
