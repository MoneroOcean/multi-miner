"use strict";

const { algoHashrateFactor } = require("./algorithms");

const UNIT_FACTORS = {
  h: 1,
  hs: 1,
  "h/s": 1,
  kh: 1e3,
  khs: 1e3,
  "kh/s": 1e3,
  mh: 1e6,
  mhs: 1e6,
  "mh/s": 1e6,
  gh: 1e9,
  ghs: 1e9,
  "gh/s": 1e9,
  th: 1e12,
  ths: 1e12,
  "th/s": 1e12,
  gps: 1,
  "g/s": 1,
};

const HASHRATE_PARSERS = [
  parser("XMRig old", 1, /\[[^\]]+\] speed 2.5s\/60s\/15m [\d.]+ ([\d.]+)\s/, 1),
  parser("XMRig", 1, /\[[^\]]+\] speed 10s\/60s\/15m [\d.n/a]+ ([\d.]+)\s/, 1),
  parser("XMRig v6", 1, /\s+miner\s+speed 10s\/60s\/15m [\d.n/a]+ ([\d.]+)\s/, 1),
  parser("xmr-stak", 1, /Totals \(ALL\):\s+[\d.]+\s+([1-9]\d*\.\d+|0\.[1-9]\d*)\s/, 1),
  parser("Claymore", 1, /Total Speed:\s*([\d.]+)\s*H\/s,/i, 1),
  parser("CryptoDredge", 1, /\(Avr\s+([\d.]+)\s*H\/s\)/i, 1),
  unitParser("SRBMiner-Multi", 3, /Total:\s*([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
  unitParser("TeamRedMiner", 3, /Total[^:]*:\s*([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
  parser("Grin reference", 1, /Mining at\s+([\d.]+)\s*gps/i, 1),
  parser("Swap reference", 1, /mining at\s+([\d.]+)\s*gps/i, 1),
  parser("MoneroVMiner", 2, /Total\s+:\s+([\d.]+)\s*gps/i, 1),
  parser("GMiner c29", 2, /\b([\d.]+)\s*G\/s\b/, 1),
  unitParser("GMiner", 2, /\b(?:Speed|Total speed|Total Speed):?\s*([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
  unitParser("lolMiner", 3, /Average speed \(15s\):\s*([\d.]+)\s*([kMGT]?h)\/s\b/i, 1, 2),
  unitParser("Rigel", 3, /\bspeed(?: 10s)?:\s*([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
  unitParser("Rigel table", 3, /\|\s*Total:\s*([\d.]+)\s*([kMGT]?H)\/s\s*\|/i, 1, 2),
  unitParser("T-Rex", 3, /\b(?:Hashrate|Total):\s*([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
  unitParser("GMiner table", 2, /\|\s*\d+\s+[^|]+\s+([\d.]+)\s*([kMGT]?H)\/s\s+[\d/]+\s*\|/i, 1, 2),
  unitParser("BzMiner", 3, /\b(?:Total|Hashrate):\s*([\d.]+)\s*([kMGT]?H\/s)\b/i, 1, 2),
  unitParser("BzMiner table", 3, /\|\s*smry\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([\d.]+)\s*([kMGT]?H)\/s\s*\|/i, 1, 2),
  unitParser("NBMiner", 3, /\b(?:Total|speed):\s*([\d.]+)\s*([kMGT]?H\/s)\b/i, 1, 2),
  unitParser("NBMiner summary", 3, /\|\s*Total:\s*([\d.]+)\s*([kMGT]?H)?\s*\|/i, 1, 2),
  unitParser("Team Black Miner", 3, /\bTotal hashrate:\s*([\d.]+)\s*([kMGT]?H\/s)\b/i, 1, 2),
  unitParser("legacy unit", 2, /\b([\d.]+)\s*([kMGT]?H)\/s\b/i, 1, 2),
];

function parser(name, stabilization, regex, valueGroup, scale) {
  return { name, stabilization, regex, valueGroup, scale: scale || 1 };
}

function unitParser(name, stabilization, regex, valueGroup, unitGroup) {
  return { name, stabilization, regex, valueGroup, unitGroup };
}

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex -- intentional ANSI escape (\x1b) for stripping terminal color codes
  return String(str).replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeUnit(unit) {
  const normalized = String(unit || "h/s").toLowerCase().replace(/\s+/g, "");
  if (/^[kmgt]h$/.test(normalized)) return normalized + "/s";
  return normalized;
}

function unitFactor(unit) {
  return UNIT_FACTORS[normalizeUnit(unit)] || 1;
}

function globalRegex(regex) {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  return new RegExp(regex.source, flags);
}

function hashrateFromMatch(match, entry, algo) {
  const rawValue = String(match[entry.valueGroup]).replace(/,/g, "");
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unitScale = entry.unitGroup ? unitFactor(match[entry.unitGroup]) : entry.scale;
  return value * unitScale * algoHashrateFactor(algo);
}

function forEachHashrate(str, algo, cb, onlyParserIndex) {
  const text = stripAnsi(str);
  for (let i = 0; i < HASHRATE_PARSERS.length; i++) {
    const selected = typeof onlyParserIndex === "function" ? onlyParserIndex() : onlyParserIndex;
    if (selected >= 0 && i !== selected) continue;
    const entry = HASHRATE_PARSERS[i];
    const regex = globalRegex(entry.regex);
    let match = regex.exec(text);
    while (match) {
      const hashrate = hashrateFromMatch(match, entry, algo);
      if (hashrate !== null && cb(hashrate, entry, i) === false) return false;
      // A zero-width match leaves lastIndex unchanged; nudge it forward so the global exec loop cannot spin forever.
      if (regex.lastIndex === match.index) regex.lastIndex++;
      match = regex.exec(text);
    }
  }
  return true;
}

function extractHashrates(str, algo) {
  const rates = [];
  forEachHashrate(str, algo, (hashrate, entry) => {
    rates.push({ hashrate, parser: entry.name });
  });
  return rates;
}

module.exports = {
  HASHRATE_PARSERS,
  extractHashrates,
  forEachHashrate,
  stripAnsi,
  unitFactor,
};
