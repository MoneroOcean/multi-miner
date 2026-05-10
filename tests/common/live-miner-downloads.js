"use strict";

const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { findMinerBinary, liveMinerRoot } = require("./live-miner-cache");

const USER_AGENT = "mm-live-tests";
const ARCHIVE_PATH_ESCAPE_PATTERN = /(^|\/)\.\.(\/|$)/;
const ARCHIVE_SUFFIX = /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2|\.zip)$/i;
const LINUX_X64 = process.platform === "linux" && process.arch === "x64";
const WIN_X64 = process.platform === "win32" && process.arch === "x64";
const RELEASES = {
  "xmrig-mo": {
    api: "https://api.github.com/repos/MoneroOcean/xmrig/releases/latest",
    prefix: "https://github.com/MoneroOcean/xmrig/releases/download/",
    binary: process.platform === "win32" ? "xmrig.exe" : "xmrig",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /lin64-compat/i.test(asset.name),
      (asset) => LINUX_X64 && /lin64.*\.tar\.gz$/i.test(asset.name),
      (asset) => process.platform === "darwin" && /mac.*\.(tar\.gz|zip)$/i.test(asset.name),
      (asset) => WIN_X64 && /win64.*\.zip$/i.test(asset.name),
    ]),
  },
  "srbminer-multi": {
    api: "https://api.github.com/repos/doktor83/SRBMiner-Multi/releases/latest",
    prefix: "https://github.com/doktor83/SRBMiner-Multi/releases/download/",
    binary: process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /^SRBMiner-Multi-.*-Linux\.tar\.(gz|xz)$/i.test(asset.name),
      (asset) => WIN_X64 && /^SRBMiner-Multi-.*-win64\.zip$/i.test(asset.name),
    ]),
  },
  mominer: {
    api: "https://api.github.com/repos/MoneroOcean/mominer/releases/latest",
    prefix: "https://github.com/MoneroOcean/mominer/releases/download/",
    binary: "mominer.js",
    suffix: /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2)$/i,
    asset: (assets) => LINUX_X64
      ? pickAsset(assets, [(asset) => /mominer/i.test(asset.name) && /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(asset.name), (asset) => /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(asset.name)])
      : null,
  },
  lolminer: {
    api: "https://api.github.com/repos/Lolliedieb/lolMiner-releases/releases/latest",
    prefix: "https://github.com/Lolliedieb/lolMiner-releases/releases/download/",
    binary: process.platform === "win32" ? "lolMiner.exe" : "lolMiner",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /lin(ux)?64.*\.(tar\.gz|tgz)$/i.test(asset.name),
      (asset) => WIN_X64 && /win64.*\.zip$/i.test(asset.name),
    ]),
  },
  gminer: {
    api: "https://api.github.com/repos/develsoftware/GMinerRelease/releases/latest",
    prefix: "https://github.com/develsoftware/GMinerRelease/releases/download/",
    binary: process.platform === "win32" ? "miner.exe" : "miner",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /linux64.*\.tar\.xz$/i.test(asset.name),
      (asset) => WIN_X64 && /windows64.*\.zip$/i.test(asset.name),
    ]),
  },
  rigel: {
    api: "https://api.github.com/repos/rigelminer/rigel/releases/latest",
    prefix: "https://github.com/rigelminer/rigel/releases/download/",
    binary: process.platform === "win32" ? "rigel.exe" : "rigel",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /linux.*\.(tar\.gz|tgz)$/i.test(asset.name),
      (asset) => WIN_X64 && /win.*\.zip$/i.test(asset.name),
    ]),
  },
  trex: {
    api: "https://api.github.com/repos/trexminer/T-Rex/releases/latest",
    prefix: "https://github.com/trexminer/T-Rex/releases/download/",
    binary: process.platform === "win32" ? "t-rex.exe" : "t-rex",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /linux.*\.(tar\.gz|tgz)$/i.test(asset.name),
      (asset) => WIN_X64 && /win.*\.zip$/i.test(asset.name),
    ]),
  },
};

async function ensureMinerBinary(cacheKey) {
  const spec = RELEASES[cacheKey];
  if (!spec) return "";
  const cached = findMinerBinary(cacheKey, spec.binary);
  if (cached || process.env.MM_LIVE_DOWNLOAD === "0") return cached;
  try {
    await ensureReleaseAsset(cacheKey, spec);
  } catch (error) {
    process.stderr.write(`live miner download skipped for ${cacheKey}: ${error.message}\n`);
  }
  return findMinerBinary(cacheKey, spec.binary);
}

async function ensureMinerBinaries(cacheKeys) {
  const unique = [...new Set(cacheKeys.filter((key) => RELEASES[key]))];
  await Promise.all(unique.map((key) => ensureMinerBinary(key)));
}

async function ensureReleaseAsset(cacheKey, spec) {
  ensureArchiveTools();
  const release = await fetchJson(spec.api);
  const asset = spec.asset(release.assets || []);
  if (!asset) throw new Error(`No ${cacheKey} asset is available for ${process.platform}/${process.arch}`);
  assertTrustedDownloadUrl(asset, spec.prefix);

  const versionDir = path.join(liveMinerRoot(), cacheKey, release.tag_name);
  const archivePath = path.join(versionDir, asset.name);
  const extractDir = path.join(versionDir, sanitizeName(asset.name.replace(spec.suffix || ARCHIVE_SUFFIX, "")));
  if (findMinerBinary(cacheKey, spec.binary)) return;

  await fsp.mkdir(versionDir, { recursive: true });
  process.stderr.write(`downloading ${cacheKey} ${release.tag_name} (${asset.name})\n`);
  if (!fs.existsSync(archivePath)) await downloadToFile(asset.browser_download_url, archivePath);
  await refreshArchiveExtraction(archivePath, extractDir);

  const binary = await findNamedFile(extractDir, spec.binary);
  if (!binary) throw new Error(`Could not find ${spec.binary} after extracting ${asset.name}`);
  if (process.platform !== "win32") await fsp.chmod(binary, 0o755);
}

async function fetchJson(url) { return await (await request(url, { Accept: "application/vnd.github+json, application/json" })).json(); }

async function downloadToFile(url, destination) {
  const response = await request(url, {});
  if (!response.body) throw new Error(`Download body missing for ${url}`);

  const tmpPath = `${destination}.part`;
  const output = fs.createWriteStream(tmpPath, { mode: 0o644 });
  try {
    await pipeline(Readable.fromWeb(response.body), output);
    await fsp.rename(tmpPath, destination);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw error;
  }
}

async function request(url, headers) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  return response;
}

async function refreshArchiveExtraction(archivePath, extractDir) {
  validateArchiveEntries(await listArchiveEntries(archivePath), archivePath);
  const tmpDir = `${extractDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await extractArchive(archivePath, tmpDir);
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.rename(tmpDir, extractDir);
}

async function listArchiveEntries(archivePath) {
  if (archivePath.endsWith(".zip")) return (await runCommand("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).filter(Boolean);
  return (await runCommand("tar", tarArchiveArgs("list", archivePath))).stdout.split(/\r?\n/).filter(Boolean);
}

async function extractArchive(archivePath, destination) {
  await fsp.mkdir(destination, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await runCommand("unzip", ["-oq", archivePath, "-d", destination]);
    return;
  }
  await runCommand("tar", [...tarArchiveArgs("extract", archivePath), "-C", destination]);
}

function validateArchiveEntries(entries, archivePath) {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (!normalized || normalized.endsWith("/")) continue;
    if (normalized.startsWith("/") || ARCHIVE_PATH_ESCAPE_PATTERN.test(normalized)) {
      throw new Error(`Unsafe path in archive ${archivePath}: ${entry}`);
    }
  }
}

function tarArchiveArgs(action, archivePath) {
  const mode = action === "list" ? "-t" : "-x";
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return [`${mode}zf`, archivePath];
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return [`${mode}Jf`, archivePath];
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return [`${mode}jf`, archivePath];
  return [`${mode}f`, archivePath];
}

function ensureArchiveTools() {
  if (!commandExists("tar")) throw new Error("Missing required archive tool: tar");
  if (process.platform === "win32" && !commandExists("unzip")) throw new Error("Missing required archive tool: unzip");
}

function commandExists(command) { return childProcess.spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0; }

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed with code ${code} signal ${signal || "none"} stderr=${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function findNamedFile(rootDir, basename) {
  if (!fs.existsSync(rootDir)) return "";
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === basename) return file;
    if (entry.isDirectory()) {
      const found = await findNamedFile(file, basename);
      if (found) return found;
    }
  }
  return "";
}

function pickAsset(assets, predicates) {
  for (const predicate of predicates) {
    const match = assets.find((asset) => asset && typeof asset.name === "string" && predicate(asset));
    if (match) return match;
  }
  return null;
}

function assertTrustedDownloadUrl(asset, prefix) {
  if (!asset || typeof asset.browser_download_url !== "string") throw new Error("Release asset is missing browser_download_url");
  if (!asset.browser_download_url.startsWith(prefix)) throw new Error(`Unsafe release download URL for ${asset.name}: ${asset.browser_download_url}`);
}

function sanitizeName(value) { return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase(); }

module.exports = {
  ensureMinerBinaries,
  ensureMinerBinary,
};
