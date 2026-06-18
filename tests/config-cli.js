"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const { BENCH_ALGOS, CURRENT_GPU_ALGOS, algoAliases, benchAlgoDeps, localAlgoPerf, normalizePoolAlgo } = require("../src/algorithms");
const { parseCommand } = require("../src/command");
const { parseArgs, parsePoolAddress } = require("../src/config");
const { createJsonLineParser, stringifyLine } = require("../src/json-lines");
const { baseParseOptions } = require("./common/helpers");

describe("config and CLI", () => {
  it("preserves -w watchdog compatibility", () => {
    const parsed = parseArgs(["-w=0", "--pool=example.com:3333", "--rx/0=miner"], baseParseOptions());
    assert.equal(parsed.config.watchdog, 0);
  });

  it("parses perf options for current algorithms and dependencies", () => {
    const parsed = parseArgs(["--perf_rx/0=42", "--perf_etchash=100", "--perf_kawpow=20000000"], baseParseOptions());
    assert.equal(parsed.config.algo_perf["rx/0"], 42);
    assert.equal(parsed.config.algo_perf["rx/sfx"], 42);
    assert.equal(parsed.config.algo_perf.etchash, 100);
    assert.equal(parsed.config.algo_perf.kawpow1, 20000000);
    assert.equal("kawpow" in parsed.config.algo_perf, false);
  });

  it("loads JSON config without executing JavaScript", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-config-"));
    const configPath = path.join(dir, "mm.json");
    fs.writeFileSync(configPath, "{\"pools\":[\"pool.test:3333\"],\"algos\":{\"rx/0\":\"miner\"}}\n");
    const parsed = parseArgs([], baseParseOptions({ cwd: dir }));
    assert.equal(parsed.config.pools[0], "pool.test:3333");
    assert.equal(parsed.config.algos["rx/0"], "miner");
  });

  it("keeps legacy saved KawPow performance under the legacy key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-kawpow-config-"));
    fs.writeFileSync(path.join(dir, "mm.json"), "{\"algo_perf\":{\"kawpow\":0.01}}\n");
    const parsed = parseArgs([], baseParseOptions({ cwd: dir }));
    assert.equal(parsed.config.algo_perf.kawpow, 0.01);
    assert.equal("kawpow1" in parsed.config.algo_perf, false);
  });

  it("validates pool addresses", () => {
    assert.deepEqual(parsePoolAddress("host:ssl443"), { host: "host", port: 443, tls: true, original: "host:ssl443" });
    assert.equal(parsePoolAddress("host:not-a-port"), null);
    assert.equal(parsePoolAddress("too:many:parts"), null);
  });
});

describe("command parsing", () => {
  it("keeps quoted paths and arguments intact", () => {
    assert.deepEqual(parseCommand("\"/opt/miners/x miner\" --config=\"my config.json\" -p 'worker one'"), [
      "/opt/miners/x miner",
      "--config=my config.json",
      "-p",
      "worker one",
    ]);
  });

  it("rejects unterminated quotes", () => {
    assert.throws(() => parseCommand("miner \"bad"), /Unterminated quote/);
  });
});

describe("algorithm metadata", () => {
  it("keeps current GPU algorithms listed", () => {
    for (const algo of ["autolykos2", "c29", "cn/gpu", "etchash", "kawpow"]) {
      assert.ok(CURRENT_GPU_ALGOS.includes(algo));
      assert.ok(BENCH_ALGOS.includes(algo));
    }
  });

  it("expands aliases and benchmark dependencies", () => {
    assert.ok(algoAliases("cryptonight/r").includes("cn/r"));
    assert.equal(benchAlgoDeps("cn/r", 30)["cn/fast"], 60);
    assert.equal(benchAlgoDeps("rx/0", 10)["rx/sfx"], 10);
    assert.equal(benchAlgoDeps("kawpow", 20_000_000).kawpow1, 20_000_000);
    assert.equal(localAlgoPerf({ algo_perf: { kawpow: 0.01 } }, "kawpow"), 0.01 * 0x100000000);
    assert.equal(localAlgoPerf({ algo_perf: { kawpow1: 20_000_000 } }, "kawpow"), 20_000_000);
    assert.equal(normalizePoolAlgo("cuckaroo", { proofsize: 42 }), "c29");
  });
});

describe("JSON-line framing", () => {
  it("handles partial chunks and invalid JSON", () => {
    const parsed = [];
    const invalid = [];
    const parser = createJsonLineParser((json) => parsed.push(json), (line) => invalid.push(line));
    parser.push("{\"a\":");
    parser.push("1}\nnot-json\n{\"b\":2}\n");
    assert.deepEqual(parsed, [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(invalid, ["not-json"]);
    assert.equal(stringifyLine({ ok: true }), "{\"ok\":true}\n");
  });

  it("drops an over-long un-terminated line instead of buffering without bound", () => {
    const parsed = [];
    let invalidCount = 0;
    const parser = createJsonLineParser((json) => parsed.push(json), () => { invalidCount += 1; });
    // Stream > 1 MiB with no newline; the parser must cap and reset, not OOM.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 6; i += 1) parser.push(chunk);
    assert.ok(invalidCount >= 1, "over-long line is reported as invalid");
    assert.deepEqual(parsed, [], "no garbage is parsed from the over-long line");
    // Close the abandoned line, then a fresh framed line parses normally (clean resync).
    parser.push("more-garbage\n{\"c\":3}\n");
    assert.deepEqual(parsed, [{ c: 3 }]);
  });
});
