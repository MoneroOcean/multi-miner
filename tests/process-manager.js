"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const { describe, it } = require("node:test");

const { startMiner } = require("../src/process-manager");

describe("Miner executable paths", { concurrency: false }, () => {
  const cases = [
    ["win32", ".\\bzminer.exe", "C:\\fixture\\bzminer.exe"],
    ["win32", "./miners/bzminer.exe", "C:\\fixture\\miners\\bzminer.exe"],
    ["win32", "miners with spaces\\bzminer.exe", "C:\\fixture\\miners with spaces\\bzminer.exe"],
    ["win32", "C:bzminer.exe", "C:\\fixture\\bzminer.exe"],
    ["win32", "C:\\miners\\bzminer.exe", "C:\\miners\\bzminer.exe"],
    ["win32", "\\\\server\\miners\\bzminer.exe", "\\\\server\\miners\\bzminer.exe"],
    ["win32", "bzminer.exe", "bzminer.exe"],
    ["linux", "./miners/bzminer", "./miners/bzminer"],
  ];
  for (const [platform, executable, expected] of cases) {
    it(`preserves spawn semantics for ${platform} executable ${executable}`, (t) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      const cwd = t.mock.method(process, "cwd", () => "C:\\fixture");
      const spawn = t.mock.method(childProcess, "spawn", () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      });
      const args = ["-a", "cn/gpu", "--pass", "worker with spaces", "--", "literal&token"];
      try {
        Object.defineProperty(process, "platform", { value: platform });
        startMiner([executable, ...args]);
        assert.equal(spawn.mock.callCount(), 1);
        assert.equal(spawn.mock.calls[0].arguments[0], expected);
        assert.deepEqual(spawn.mock.calls[0].arguments[1], args);
        assert.deepEqual(spawn.mock.calls[0].arguments[2], {});
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        cwd.mock.restore();
      }
    });
  }

  it("preserves quoted arguments through the command-to-spawn boundary", (t) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const cwd = t.mock.method(process, "cwd", () => "C:\\fixture");
    const spawn = t.mock.method(childProcess, "spawn", () => new EventEmitter());
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      startMiner('".\\\\miners with spaces\\\\bzminer.exe" --pass "worker with spaces"', { minerStdin: true });
      assert.deepEqual(spawn.mock.calls[0].arguments, [
        "C:\\fixture\\miners with spaces\\bzminer.exe",
        ["--pass", "worker with spaces"],
        { stdio: ["inherit", "pipe", "pipe"] },
      ]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      cwd.mock.restore();
    }
  });
});
