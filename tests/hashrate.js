"use strict";

const assert = require("assert");
const { describe, it } = require("node:test");

const { extractHashrates } = require("../src/hashrate");
const { nearlyEqual } = require("./common/helpers");

describe("hashrate extraction", () => {
  const fixtures = [
    ["XMRig", "[2026] speed 10s/60s/15m n/a 123.4 120.0 H/s", "rx/0", 123.4],
    ["xmr-stak", "Totals (ALL):   100.0  250.5 H/s", "rx/0", 250.5],
    ["SRBMiner-Multi", "Total: 1.25 MH/s", "rx/0", 1250000],
    ["lolMiner", "Average speed (15s): 99.5 Mh/s", "autolykos2", 99500000],
    ["GMiner c29", "GPU0 42.0 G/s", "c29", 1],
    ["GMiner table", "|  0 A16-16Q  19.24 MH/s  0/0/0 |", "etchash", 19240000],
    ["TeamRedMiner", "Total GPU: 11.2 kh/s", "rx/0", 11200],
    ["T-Rex", "Hashrate: 120.5 MH/s", "kawpow", 120500000],
    ["Rigel", "speed 10s: 77.7 MH/s", "etchash", 77700000],
    ["Rigel table", "|          Total: 77.7 MH/s|   -|  0|  0|n/a|", "etchash", 77700000],
    ["BzMiner", "Total: 88.8 MH/s", "ethash", 88800000],
    ["BzMiner table", "| smry | 0/0/0 |     | --  | --  | --      | 88.8 MH/s | Mining |", "ethash", 88800000],
    ["NBMiner", "speed: 66.6 MH/s", "ethash", 66600000],
    ["NBMiner summary", "|    Total:  66.6 MH |     0|     0|  0|", "ethash", 66600000],
    ["Team Black Miner", "Total hashrate: 55.5 MH/s", "ethash", 55500000],
    ["CryptoDredge", "(Avr 444.0H/s)", "rx/0", 444],
    ["Claymore", "Total Speed: 333.0 H/s,", "rx/0", 333],
  ];

  for (const [name, line, algo, expected] of fixtures) {
    it(`parses ${  name}`, () => {
      const rates = extractHashrates(line, algo);
      assert.ok(rates.some((rate) => nearlyEqual(rate.hashrate, expected)));
    });
  }

  it("ignores zero-valued share status noise", () => {
    assert.deepEqual(extractHashrates("[ OK ] 1/1 - 0.00 H/s, 1ms ... GPU #0", "etchash"), []);
  });
});
