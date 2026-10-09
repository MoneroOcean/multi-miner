"use strict";

const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { findMinerBinary, liveMinerRoot } = require("./live-miner-cache");
const { safeFailureClass } = require("./live-helpers");

const USER_AGENT = "mm-live-tests";
const ARCHIVE_PATH_ESCAPE_PATTERN = /(^|\/)\.\.(\/|$)/;
const ARCHIVE_WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const MAX_ARCHIVE_LINK_EXPANSIONS = 1024;
const ARCHIVE_SUFFIX = /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2|\.zip)$/i;
const LINUX_X64 = process.platform === "linux" && process.arch === "x64";
const WIN_X64 = process.platform === "win32" && process.arch === "x64";
const RELEASES = {
  "xmrig-mo": {
    api: "https://api.github.com/repos/MoneroOcean/xmrig/releases/latest",
    prefix: "https://github.com/MoneroOcean/xmrig/releases/download/",
    binary: process.platform === "win32" ? "xmrig.exe" : "xmrig",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /lin(?:64)?-compat\.tar\.gz$/i.test(asset.name),
      (asset) => LINUX_X64 && /lin(?:64)?\.tar\.gz$/i.test(asset.name),
      (asset) => process.platform === "darwin" && /mac.*\.(tar\.gz|zip)$/i.test(asset.name),
      (asset) => WIN_X64 && /win(?:64)?\.zip$/i.test(asset.name),
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
  bzminer: {
    api: "https://api.github.com/repos/bzminer/bzminer/releases/latest",
    prefix: "https://github.com/bzminer/bzminer/releases/download/",
    binary: process.platform === "win32" ? "bzminer.exe" : "bzminer",
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /^bzminer_v.*_linux\.tar\.gz$/i.test(asset.name),
      (asset) => WIN_X64 && /^bzminer_v.*_windows\.zip$/i.test(asset.name),
    ]),
  },
  "xmrig-cuda": {
    api: "https://api.github.com/repos/MoneroOcean/xmrig-cuda/releases/latest",
    prefix: "https://github.com/MoneroOcean/xmrig-cuda/releases/download/",
    binary: process.platform === "win32" ? "xmrig-cuda.dll" : "libxmrig-cuda.so",
    asset: (assets) => pickAsset(assets, [
      (asset) => WIN_X64 && /^xmrig-cuda-v.*-cuda\d+(?:_\d+)?-win64\.zip$/i.test(asset.name),
    ]),
  },
  "mom": {
    api: "https://api.github.com/repos/MoneroOcean/mo-miner/releases/latest",
    prefix: "https://github.com/MoneroOcean/mo-miner/releases/download/",
    binary: process.platform === "win32" ? "mom.cmd" : "mom",
    suffix: /(\.tar\.(gz|xz|bz2)|\.tgz|\.txz|\.tbz2|\.zip)$/i,
    asset: (assets) => pickAsset(assets, [
      (asset) => LINUX_X64 && /^mom-v.*-lin\.tgz$/i.test(asset.name),
      (asset) => WIN_X64 && /^mom-v.*-win\.zip$/i.test(asset.name),
    ]),
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

async function ensureMinerBinary(cacheKey, options = {}) {
  const spec = RELEASES[cacheKey];
  if (!spec) return "";
  if (process.env.MM_LIVE_DOWNLOAD === "0") return findMinerBinary(cacheKey, spec.binary);
  try {
    return await ensureReleaseAsset(cacheKey, spec, options);
  } catch (error) {
    process.stderr.write(`live miner download failure=${safeFailureClass(error)}\n`);
  }
  return "";
}

async function ensureMinerBinaries(cacheKeys, options = {}) {
  const requested = [...new Set(cacheKeys.filter((key) => typeof key === "string" && key))];
  const supported = requested.filter((key) => RELEASES[key]);
  const unsupported = requested.filter((key) => !RELEASES[key]).map((key) => [key, null]);
  const binaries = await Promise.all(supported.map(async (key) => [key, await ensureMinerBinary(key, options)]));
  return Object.fromEntries([...binaries, ...unsupported]);
}

async function ensureReleaseAsset(cacheKey, spec, options = {}) {
  if (!options.extractionRoot) throw new Error("Online miner resolution requires an invocation-owned extractionRoot");
  const fetchRelease = options.fetchJson || fetchJson;
  const download = options.downloadToFile || downloadToFile;
  const extract = options.refreshArchiveExtraction || refreshArchiveExtraction;
  const checkTools = options.ensureArchiveTools || ensureArchiveTools;
  const cacheRoot = options.cacheRoot || liveMinerRoot();
  checkTools();
  const release = await fetchRelease(spec.api);
  const asset = spec.asset(release.assets || []);
  if (!asset) throw new Error(`No ${cacheKey} asset is available for ${process.platform}/${process.arch}`);
  assertSafeAssetName(asset.name);
  assertTrustedDownloadUrl(asset, spec.prefix);
  const expectedDigest = parseAssetDigest(asset.digest);
  if (cacheKey === 'mom' && !expectedDigest) throw new Error('MoM release asset is missing its SHA-256 digest');

  const versionDir = releaseCacheDir(cacheRoot, cacheKey, release.tag_name);
  const archivePath = path.join(versionDir, asset.name);
  const extractName = sanitizeName(asset.name.replace(spec.suffix || ARCHIVE_SUFFIX, ""));
  if (!extractName || extractName === "." || extractName === "..") throw new Error(`Release asset has no safe extraction name: ${asset.name}`);
  // Never replace a shared executable tree: another invocation may still use it.
  const extractDir = path.join(options.extractionRoot, `${extractName}-${crypto.randomBytes(8).toString("hex")}`);

  await fsp.mkdir(versionDir, { recursive: true });
  let archiveReady = fs.existsSync(archivePath);
  if (archiveReady && expectedDigest && !(await assetDigestMatches(archivePath, expectedDigest))) {
    await fsp.rm(archivePath, { force: true });
    archiveReady = false;
  }

  process.stderr.write("live miner download status=started\n");
  if (!archiveReady) await download(asset.browser_download_url, archivePath);
  if (expectedDigest && !(await assetDigestMatches(archivePath, expectedDigest))) {
    await fsp.rm(archivePath, { force: true });
    throw new Error(`Digest mismatch for ${cacheKey} release asset ${asset.name}`);
  }
  await extract(archivePath, extractDir);
  await validateExtractedTree(extractDir, archivePath);

  const binary = await findNamedFile(extractDir, spec.binary);
  if (!binary) throw new Error(`Could not find ${spec.binary} after extracting ${asset.name}`);
  await validateLocatedBinary(binary, extractDir, archivePath);
  if (process.platform !== "win32") await fsp.chmod(binary, 0o755);
  return binary;
}

async function fetchJson(url) { return await (await request(url, { Accept: "application/vnd.github+json, application/json" })).json(); }

async function downloadToFile(url, destination) {
  const response = await request(url, {});
  if (!response.body) throw new Error(`Download body missing for ${url}`);

  const tmpPath = `${destination}.part-${crypto.randomBytes(8).toString("hex")}`;
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
  const archiveEntries = await listArchiveEntries(archivePath);
  validateArchiveEntries(archiveEntries, archivePath);
  await validateArchiveLinks(await listArchiveLinks(archivePath, archiveEntries), archivePath, archiveEntries);
  const tmpDir = `${extractDir}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await extractArchive(archivePath, tmpDir);
  await validateExtractedTree(tmpDir, archivePath);

  const backupDir = `${extractDir}.old-${crypto.randomBytes(4).toString("hex")}`;
  let movedOld = false;
  try {
    await fsp.rename(extractDir, backupDir);
    movedOld = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fsp.rename(tmpDir, extractDir);
  } catch (error) {
    if (movedOld) {
      try {
        await fsp.rename(backupDir, extractDir);
      } catch (_restoreError) {
        throw new Error("Archive replacement failed and the previous extraction remains in its backup path");
      }
    }
    throw error;
  }
  if (movedOld) await fsp.rm(backupDir, { recursive: true, force: true });
}

async function listArchiveEntries(archivePath) {
  if (isZipArchive(archivePath)) return (await runCommand("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).filter(Boolean);
  return (await runCommand("tar", tarArchiveArgs("list", archivePath))).stdout.split(/\r?\n/).filter(Boolean);
}

async function listArchiveLinks(archivePath, archiveEntries) {
  if (isZipArchive(archivePath)) {
    const types = zipEntryTypes((await runCommand("unzip", ["-Z", "-l", archivePath])).stdout, archiveEntries.length, archivePath);
    const links = [];
    for (let index = 0; index < archiveEntries.length; index += 1) {
      if (types[index] !== "l" && types[index] !== "h") continue;
      const target = (await runCommand("unzip", ["-p", archivePath, archiveEntries[index]])).stdout;
      links.push({ type: types[index], name: archiveEntries[index], target });
    }
    return links;
  }

  let output;
  try {
    output = (await runCommand("tar", tarVerboseArchiveArgs(archivePath))).stdout;
  } catch (_error) {
    output = (await runCommand("tar", tarPlainVerboseArchiveArgs(archivePath))).stdout;
  }
  return output.split(/\r?\n/).filter(Boolean)
    .map((line) => parseTarLink(line, archivePath, archiveEntries))
    .filter(Boolean);
}

async function extractArchive(archivePath, destination) {
  await fsp.mkdir(destination, { recursive: true });
  if (isZipArchive(archivePath)) {
    await runCommand("unzip", ["-oq", archivePath, "-d", destination]);
    return;
  }
  await runCommand("tar", [...tarArchiveArgs("extract", archivePath), "-C", destination]);
}

function tarVerboseArchiveArgs(archivePath) {
  const [flags, archive] = tarArchiveArgs("list", archivePath);
  return [`${flags[0]}v${flags.slice(1)}`, archive, "--quoting-style=escape"];
}

function tarPlainVerboseArchiveArgs(archivePath) {
  const [flags, archive] = tarArchiveArgs("list", archivePath);
  return [`${flags[0]}v${flags.slice(1)}`, archive];
}

function parseTarLink(line, archivePath, archiveEntries) {
  const type = line[0];
  if (type !== "l" && type !== "h") return null;
  const marker = type === "l" ? " -> " : " link to ";
  const markerIndex = line.indexOf(marker);
  // Repeated delimiters cannot distinguish a member name from its link target.
  if (markerIndex <= 0 || markerIndex !== line.lastIndexOf(marker)) {
    throw new Error(`Unparseable archive link in ${archivePath}`);
  }

  const left = line.slice(0, markerIndex).trim();
  const target = line.slice(markerIndex + marker.length).trim();
  const candidates = archiveEntries
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((entry) => left === entry || left.endsWith(` ${entry}`));
  const longestLength = candidates.reduce((length, entry) => Math.max(length, entry.length), 0);
  const longest = candidates.filter((entry) => entry.length === longestLength);
  if (longest.length !== 1 || !target) throw new Error(`Unparseable archive link in ${archivePath}`);
  return { type, name: longest[0], target };
}

function zipEntryTypes(output, entryCount, archivePath) {
  const types = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+/);
    if (!match) continue;
    const mode = match[1];
    if (/^[bcdlps-][^\s]{9}$/.test(mode)) types.push(mode[0]);
    else if (/^\?[^\s]{9}$/.test(mode)) types.push("-");
    else if (/^[d-][rwx-]{6}$/.test(mode)) types.push(mode[0] === "d" ? "d" : "-");
  }
  if (types.length !== entryCount) throw new Error(`Unparseable ZIP entry metadata in ${archivePath}`);
  return types;
}

function splitArchivePath(candidate, archivePath) {
  const value = String(candidate).replace(/\\/g, "/");
  if (value.includes("\0") || value.includes(":")
      || value.startsWith("/") || ARCHIVE_WINDOWS_DRIVE_PATTERN.test(value)) {
    throw new Error(`Unsafe archive link target in ${archivePath}`);
  }
  return value.split("/").filter((part) => part !== "");
}

function canonicalArchiveName(candidate, archivePath) {
  const resolved = [];
  for (const part of splitArchivePath(candidate, archivePath)) {
    if (part === ".") continue;
    if (part === "..") {
      if (!resolved.length) throw new Error(`Unsafe archive link target in ${archivePath}`);
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/") || ".";
}

function resolveArchiveLinkPath(candidate, links, archivePath) {
  const steps = { value: 0 };
  const resolveParts = (parts, resolved, stack) => {
    if (!parts.length) return resolved;
    const [part, ...remaining] = parts;
    if (part === ".") return resolveParts(remaining, resolved, stack);
    if (part === "..") {
      if (!resolved.length) throw new Error(`Unsafe archive link target in ${archivePath}`);
      return resolveParts(remaining, resolved.slice(0, -1), stack);
    }

    const next = [...resolved, part].join("/");
    const link = links.get(next);
    if (!link) return resolveParts(remaining, [...resolved, part], stack);
    if (stack.includes(next) || steps.value >= MAX_ARCHIVE_LINK_EXPANSIONS) {
      throw new Error(`Unsafe archive link cycle in ${archivePath}`);
    }
    steps.value += 1;
    const targetResolved = resolveParts(splitArchivePath(link.target, archivePath), resolved, [...stack, next]);
    return resolveParts(remaining, targetResolved, stack);
  };
  return resolveParts(splitArchivePath(candidate, archivePath), [], []).join("/") || ".";
}

async function validateArchiveLinks(links, archivePath, archiveEntries) {
  const entryNames = new Set();
  for (const entry of archiveEntries) {
    const name = canonicalArchiveName(entry, archivePath);
    if (entryNames.has(name)) throw new Error(`Duplicate archive member in ${archivePath}`);
    entryNames.add(name);
  }

  const symlinks = new Map();
  const hardlinks = new Map();
  const linkNames = new Set();
  for (const link of links) {
    if (!link || (link.type !== "l" && link.type !== "h")) {
      throw new Error(`Unparseable archive link in ${archivePath}`);
    }
    const name = canonicalArchiveName(link.name, archivePath);
    if (!entryNames.has(name) || linkNames.has(name) || !link.target) {
      throw new Error(`Unparseable archive link in ${archivePath}`);
    }
    splitArchivePath(link.target, archivePath);
    linkNames.add(name);
    (link.type === "l" ? symlinks : hardlinks).set(name, { target: link.target });
  }

  const archiveParent = (name) => {
    const separator = name.lastIndexOf("/");
    return separator < 0 ? "." : name.slice(0, separator);
  };
  const archiveBase = (name) => name.slice(name.lastIndexOf("/") + 1);
  const joinArchivePath = (parent, target) => parent === "." ? target : `${parent}/${target}`;
  // A link below a symlinked parent is created at the parent's physical path.
  // Check that layout before extraction: a post-extraction rejection is too late.
  const physicalSymlinks = new Map();
  const physicalNames = new Map();
  for (const [name, link] of symlinks) {
    const parent = resolveArchiveLinkPath(archiveParent(name), symlinks, archivePath);
    const physicalName = joinArchivePath(parent, archiveBase(name));
    if (physicalName === "." || physicalSymlinks.has(physicalName)
        || (physicalName !== name && entryNames.has(physicalName))) {
      throw new Error(`Unsafe archive link collision in ${archivePath}`);
    }
    physicalSymlinks.set(physicalName, link);
    physicalNames.set(name, physicalName);
  }

  const physicalEntries = new Set();
  for (const entry of entryNames) {
    const physicalName = symlinks.has(entry)
      ? physicalNames.get(entry)
      : resolveArchiveLinkPath(entry, physicalSymlinks, archivePath);
    physicalEntries.add(physicalName);
  }
  for (const [name, link] of symlinks) {
    const physicalName = physicalNames.get(name);
    const resolved = resolveArchiveLinkPath(
      joinArchivePath(archiveParent(physicalName), link.target), physicalSymlinks, archivePath
    );
    if (resolved !== "." && !physicalEntries.has(resolved)) {
      throw new Error(`Broken archive link in ${archivePath}`);
    }
  }
  for (const entry of entryNames) resolveArchiveLinkPath(entry, physicalSymlinks, archivePath);

  const resolveHardlink = (name, stack = [], steps = { value: 0 }) => {
    const link = hardlinks.get(name);
    if (!link) return name;
    if (stack.includes(name)) throw new Error(`Unsafe archive link cycle in ${archivePath}`);
    if (steps.value >= MAX_ARCHIVE_LINK_EXPANSIONS) throw new Error(`Unsafe archive link cycle in ${archivePath}`);
    steps.value += 1;
    const target = canonicalArchiveName(link.target, archivePath);
    if (!entryNames.has(target) || symlinks.has(target)) {
      throw new Error(`Unsafe archive hardlink target in ${archivePath}`);
    }
    return resolveHardlink(target, [...stack, name], steps);
  };
  for (const [name] of hardlinks) {
    const target = resolveHardlink(name);
    const resolved = resolveArchiveLinkPath(target, physicalSymlinks, archivePath);
    if (resolved === "." || !physicalEntries.has(resolved)) {
      throw new Error(`Unsafe archive hardlink target in ${archivePath}`);
    }
    resolveArchiveLinkPath(name, physicalSymlinks, archivePath);
  }
}

function pathIsWithin(rootDir, candidatePath) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidatePath));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function validateExtractedTree(extractDir, archivePath) {
  const groups = new Map();
  const rootStat = await fsp.lstat(extractDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe extraction root in ${archivePath}`);
  }
  const rootReal = await fsp.realpath(extractDir);

  const visit = async (currentDir) => {
    for (const entry of await fsp.readdir(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const stat = await fsp.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        const resolved = await fsp.realpath(fullPath).catch(() => {
          throw new Error(`Broken archive link in ${archivePath}`);
        });
        if (!pathIsWithin(rootReal, resolved)) {
          throw new Error(`Archive link escapes extraction root in ${archivePath}`);
        }
        continue;
      }
      if (stat.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported archive member type in ${archivePath}`);
      const key = `${stat.dev}:${stat.ino}`;
      const group = groups.get(key) || { count: 0, links: stat.nlink };
      group.count += 1;
      group.links = Math.max(group.links, stat.nlink);
      groups.set(key, group);
    }
  };
  await visit(extractDir);
  for (const group of groups.values()) {
    if (group.links > group.count) throw new Error(`Archive hardlink escapes extraction root in ${archivePath}`);
  }
}

async function validateLocatedBinary(binaryPath, extractDir, archivePath) {
  if (!pathIsWithin(extractDir, binaryPath)) {
    throw new Error(`Selected archive binary escapes extraction root in ${archivePath}`);
  }
  const stat = await fsp.lstat(binaryPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Selected archive binary is not a regular file in ${archivePath}`);
  }
  const rootReal = await fsp.realpath(extractDir);
  const binaryReal = await fsp.realpath(binaryPath);
  if (!pathIsWithin(rootReal, binaryReal)) {
    throw new Error(`Selected archive binary escapes extraction root in ${archivePath}`);
  }
}

function validateArchiveEntries(entries, archivePath) {
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry) throw new Error(`Invalid archive member in ${archivePath}`);
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.includes("\0") || normalized.includes(":")
        || normalized.startsWith("/") || ARCHIVE_WINDOWS_DRIVE_PATTERN.test(normalized)
        || ARCHIVE_PATH_ESCAPE_PATTERN.test(normalized)) {
      throw new Error(`Unsafe path in archive ${archivePath}: ${entry}`);
    }
  }
}

function isZipArchive(archivePath) {
  return archivePath.toLowerCase().endsWith(".zip");
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

function assertSafeAssetName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/:]/.test(name) || name.includes("\0")) {
    throw new Error(`Release asset has unsafe name: ${name}`);
  }
}

function parseAssetDigest(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("Release asset digest must be a sha256 string");
  const match = value.match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw new Error(`Unsupported release asset digest: ${value}`);
  return match[1].toLowerCase();
}

async function assetDigestMatches(file, expected) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex") === expected;
}

function releaseCacheDir(cacheRoot, cacheKey, tagName) {
  const safeKey = sanitizeName(cacheKey);
  const safeTag = sanitizeName(tagName);
  if (!safeKey || safeKey === "." || safeKey === "..") throw new Error(`Invalid release cache key: ${cacheKey}`);
  if (typeof tagName !== "string" || !safeTag || safeTag === "." || safeTag === "..") throw new Error("Release metadata is missing a safe tag_name");
  return path.join(cacheRoot, safeKey, safeTag);
}

function sanitizeName(value) { return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase(); }

module.exports = {
  ensureMinerBinaries,
  ensureMinerBinary,
  ensureReleaseAsset,
  isZipArchive,
  validateArchiveEntries,
  RELEASES,
};
