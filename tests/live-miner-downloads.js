"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it } = require("node:test");

const {
  ensureMinerBinaries,
  ensureMinerBinary,
  ensureReleaseAsset,
  isZipArchive,
  validateArchiveEntries,
  RELEASES,
} = require("./common/live-miner-downloads");
const { resolveMinerPaths, resolveMinerPathsForRun } = require("./live-intel-gpu-miners");
const { findXmrig } = require("./live-cpu-miners");
const { minerCommandContext, scriptCommand } = require("./live-nvidia-gpu-miners");
// These fixtures require POSIX archive tools, shell wrappers, and link semantics.
const posixArchive = { skip: process.platform === 'win32' && 'Requires POSIX archive tools and links' };

function createArchiveFixture({ archiveName, prepare, archiveBuilder, zip = false, dosZip = false, patchTarTarget, patchTarTargets }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-archive-boundary-"));
  const source = path.join(root, "source");
  const archive = path.join(root, archiveName);
  const cacheRoot = path.join(root, "cache");
  const extractionRoot = path.join(root, "invocation");
  fs.mkdirSync(extractionRoot);
  fs.mkdirSync(source, { recursive: true });
  prepare(source);
  if (archiveBuilder) {
    archiveBuilder({ root, source, archive });
  } else if (zip) {
    childProcess.execFileSync("zip", ["-q", "-r", "-y", archive, "."], { cwd: source, stdio: "ignore" });
    if (dosZip) patchZipDosMetadata(archive);
  } else {
    childProcess.execFileSync("tar", ["-cf", archive, "-C", source, "."], { stdio: "ignore" });
    if (patchTarTarget) patchTarHardlinkTarget(archive, patchTarTarget.member, patchTarTarget.target);
    if (patchTarTargets) patchTarHardlinkTargets(archive, patchTarTargets);
  }

  const spec = {
    api: "https://fixture.invalid/release",
    prefix: "https://fixture.invalid/download/",
    binary: "mom",
    suffix: zip ? /\.zip$/i : /\.tar$/i,
    asset: (assets) => assets[0],
  };
  const asset = {
    name: archiveName,
    browser_download_url: `${spec.prefix}vfixture/${archiveName}`,
    digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}`,
  };
  const options = {
    cacheRoot,
    extractionRoot,
    ensureArchiveTools: () => {},
    fetchJson: async () => ({ tag_name: "vfixture", assets: [asset] }),
    downloadToFile: async (_url, destination) => { fs.copyFileSync(archive, destination); },
  };
  const extractDir = path.join(cacheRoot, "fixture", "vfixture", archiveName.replace(/\.tar$|\.zip$/i, "").toLowerCase());
  return { root, source, archive, cacheRoot, extractionRoot, spec, options, extractDir };
}

function patchZipDosMetadata(archive) {
  const bytes = fs.readFileSync(archive);
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    bytes[offset + 5] = 0;
    bytes.writeUInt32LE(0, offset + 38);
  }
  fs.writeFileSync(archive, bytes);
}

function patchTarHardlinkTarget(archive, member, target) {
  patchTarHardlinkTargets(archive, [{ member, target }]);
}

function patchTarHardlinkTargets(archive, patches) {
  const bytes = fs.readFileSync(archive);
  const remaining = [...patches];
  for (let offset = 0; offset + 512 <= bytes.length && remaining.length; offset += 512) {
    const name = bytes.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
    const patch = remaining.find((candidate) => name.endsWith(candidate.member));
    if (!patch) continue;
    bytes[offset + 156] = "1".charCodeAt(0);
    bytes.fill(0, offset + 157, offset + 257);
    bytes.write(patch.target, offset + 157, "utf8");
    bytes.fill(0x20, offset + 148, offset + 156);
    let checksum = 0;
    for (let index = offset; index < offset + 512; index += 1) checksum += bytes[index];
    bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
    remaining.splice(remaining.indexOf(patch), 1);
  }
  if (remaining.length) throw new Error("hardlink fixture member missing");
  fs.writeFileSync(archive, bytes);
}

async function fixtureEnsure(fixture) {
  const binary = await ensureReleaseAsset("fixture", fixture.spec, fixture.options);
  fixture.extractDir = path.join(fixture.extractionRoot, path.relative(fixture.extractionRoot, binary).split(path.sep)[0]);
  return binary;
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function withTarExtractionCounter(fixture, action) {
  const bin = path.join(fixture.root, "bin");
  const marker = path.join(fixture.root, "tar-extractions");
  const realTar = childProcess.execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "tar"),
    "#!/bin/sh\nif [ \"$1\" = \"-xf\" ]; then printf '%s\\n' extraction >> \"$MM_TEST_TAR_MARKER\"; fi\nexec \"$MM_TEST_REAL_TAR\" \"$@\"\n",
    { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousMarker = process.env.MM_TEST_TAR_MARKER;
  const previousTar = process.env.MM_TEST_REAL_TAR;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ""}`;
  process.env.MM_TEST_TAR_MARKER = marker;
  process.env.MM_TEST_REAL_TAR = realTar;
  try {
    return await action(marker);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.MM_TEST_TAR_MARKER;
    else process.env.MM_TEST_TAR_MARKER = previousMarker;
    if (previousTar === undefined) delete process.env.MM_TEST_REAL_TAR;
    else process.env.MM_TEST_REAL_TAR = previousTar;
  }
}

describe("live miner release downloads", () => {
  it("uses valid explicit CPU and Intel paths without fetching release metadata", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-explicit-miner-paths-"));
    const keys = ["XMRIG_PATH", "MOM_PATH", "SRBMINER_PATH", "MM_LIVE_DOWNLOAD"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    let fetches = 0;
    t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected fetch"); });
    try {
      for (const key of keys.slice(0, 3)) {
        process.env[key] = path.join(root, key);
        fs.writeFileSync(process.env[key], "unexecuted fixture");
      }
      process.env.MM_LIVE_DOWNLOAD = "1";
      assert.equal(await findXmrig(root), process.env.XMRIG_PATH);
      assert.deepEqual(await resolveMinerPathsForRun(root), {mom: process.env.MOM_PATH, srbminer: process.env.SRBMINER_PATH});
      assert.equal(fetches, 0);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it("requires an invocation-owned extraction root before online work", async () => {
    let fetched = false;
    await assert.rejects(ensureReleaseAsset("fixture", {}, {
      fetchJson:async()=>{ fetched=true; },
    }), /invocation-owned extractionRoot/);
    assert.equal(fetched,false);
  });

  it("isolates concurrent downloads and invocation cleanup", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-concurrent-extraction-"));
    const bytes = Buffer.from("verified parallel archive");
    const destinations = [];
    const createWriteStream = fs.createWriteStream;
    t.mock.method(fs, "createWriteStream",(file, options) => {
      destinations.push(file);
      return createWriteStream(file, options);
    });
    t.mock.method(globalThis, "fetch", async ()=>({ok: true, body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0,8));
        setTimeout(() => {controller.enqueue(bytes.subarray(8));controller.close();},20);
      },
    })}));
    const spec = {api: "fixture", prefix: "fixture:", binary: "miner", asset: assets =>assets[0]};
    const options = {cacheRoot: path.join(root, "cache"), ensureArchiveTools: () => {},
      fetchJson: async ()=>({tag_name: "vfixture", assets: [{name: "asset.zip", browser_download_url: "fixture:archive",
        digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`}]}),
      refreshArchiveExtraction: async (_archive, destination) => {
        fs.mkdirSync(destination, {recursive: true});fs.writeFileSync(path.join(destination, "miner"), "fixture binary");
      }};
    const firstRoot = path.join(root, "first-invocation"), secondRoot = path.join(root, "second-invocation");
    try {
      const [first, second]=await Promise.all([firstRoot, secondRoot].map(extractionRoot =>ensureReleaseAsset("fixture", spec, {...options, extractionRoot})));
      assert.equal(destinations.length,2);
      assert.equal(new Set(destinations).size,2, "parallel downloads must not share a .part file");
      assert.equal(destinations.every(file =>!fs.existsSync(file)), true, "completed download staging files are removed");
      assert.notEqual(first, second);
      fs.rmSync(firstRoot, {recursive: true, force: true});
      assert.equal(fs.existsSync(first), false);
      assert.equal(fs.readFileSync(second, "utf8"), "fixture binary", "one invocation's cleanup cannot remove another's binary");
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });

  it("validates every archive entry, including unsafe directory entries", () => {
    assert.doesNotThrow(() => validateArchiveEntries(["safe/", "safe/file"], "fixture.zip"));
    for (const entry of [
      "../",
      "nested/../../escape",
      "/absolute/file",
      "C:/absolute/file",
      "C:\\absolute\\file",
      "safe\0file",
      "safe:stream",
    ]) {
      assert.throws(() => validateArchiveEntries([entry], "fixture.zip"), /Unsafe path in archive/);
    }
    assert.equal(isZipArchive("fixture.ZIP"), true);
    assert.equal(isZipArchive("fixture.tar.gz"), false);
  });

  it("selects the official BZMiner and XMRig CUDA release asset shapes", () => {
    const bzAsset = RELEASES.bzminer.asset([
      { name: "bzminer_custom-v100.45.tar.gz" },
      { name: "bzminer_v100.45_linux.tar.gz" },
      { name: "bzminer_v100.45_windows.zip" },
    ]);
    const expectedBzName = process.platform === "win32" && process.arch === "x64"
      ? "bzminer_v100.45_windows.zip"
      : process.platform === "linux" && process.arch === "x64"
        ? "bzminer_v100.45_linux.tar.gz"
        : null;
    assert.equal(bzAsset?.name, expectedBzName);

    const cudaAsset = RELEASES["xmrig-cuda"].asset([
      { name: "xmrig-cuda-v6.22.1-mo1-cuda11_4-win64.zip" },
    ]);
    assert.equal(cudaAsset?.name || null, process.platform === "win32" && process.arch === "x64"
      ? "xmrig-cuda-v6.22.1-mo1-cuda11_4-win64.zip"
      : null);
  });

  it("fails closed for requested release keys without metadata", async () => {
    let archiveToolsChecked = false;
    const resolved = await ensureMinerBinaries(["unpublished-miner", "unpublished-miner"], {
      ensureArchiveTools: () => { archiveToolsChecked = true; },
    });
    assert.deepEqual(resolved, { "unpublished-miner": null });
    assert.equal(archiveToolsChecked, false, "unsupported keys must not use stale archive/cache paths");
    assert.equal(scriptCommand("unpublished-miner", "./miner --version", resolved), "");
  });

  it("rejects a MoM release without a digest before using cached output or downloading", async () => {
    const spec = RELEASES.mom;
    const assetName = process.platform === "win32" ? "mom-v0.9.0-win.zip" : "mom-v0.9.0-lin.tgz";
    const asset = { name: assetName, browser_download_url: `${spec.prefix}v0.9.0/${assetName}` };
    if (!spec.asset([asset])) return;
    let downloaded = false;
    await assert.rejects(ensureReleaseAsset("mom", spec, {
      extractionRoot: "unused-before-digest-validation",
      ensureArchiveTools: () => {},
      fetchJson: async () => ({ tag_name: "v0.9.0", assets: [asset] }),
      downloadToFile: async () => { downloaded = true; },
    }), /missing its SHA-256 digest/);
    assert.equal(downloaded, false);
  });

  it("uses the resolved MoM release directory and verifies its cached asset", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-release-cache-"));
    const previousDownload = process.env.MM_LIVE_DOWNLOAD;
    process.env.MM_LIVE_DOWNLOAD = "1";
    try {
      const spec = RELEASES.mom;
      const binary = spec.binary;
      const assetName = process.platform === "win32" ? "mom-vfixture-win.zip" : "mom-vfixture-lin.tgz";
      const asset = {
        name: assetName,
        browser_download_url: `https://github.com/MoneroOcean/mo-miner/releases/download/vfixture/${assetName}`,
        digest: `sha256:${crypto.createHash("sha256").update("fixture archive").digest("hex")}`,
      };
      const release = { tag_name: "vfixture", assets: [asset] };
      if (!spec.asset(release.assets)) {
        assert.equal(process.platform, "darwin", "MoM's fixture asset should be selected on supported platforms");
        return;
      }

      const oldBinary = path.join(cacheRoot, "mom", "old-release", "old-tree", binary);
      fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
      fs.writeFileSync(oldBinary, "old release");
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(oldBinary, future, future);

      let fetchCount = 0;
      let downloadCount = 0;
      let extractCount = 0;
      const options = {
        cacheRoot,
        extractionRoot: path.join(cacheRoot, "invocation"),
        ensureArchiveTools: () => {},
        fetchJson: async (url) => {
          fetchCount++;
          assert.equal(url, spec.api);
          return release;
        },
        downloadToFile: async (url, destination) => {
          downloadCount++;
          assert.equal(url, asset.browser_download_url);
          fs.writeFileSync(destination, "fixture archive");
        },
        refreshArchiveExtraction: async (_archivePath, destination) => {
          extractCount++;
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(path.join(destination, binary), "fixture binary");
        },
      };

      const first = await ensureMinerBinary("mom", options);
      assert.equal(path.relative(options.extractionRoot, first).startsWith(".."), false);
      assert.notEqual(first, oldBinary, "an older release must not win by cache mtime");
      assert.equal(fetchCount, 1);
      assert.equal(downloadCount, 1);
      assert.equal(extractCount, 1);

      const cached = await ensureMinerBinary("mom", options);
      assert.notEqual(cached, first);
      assert.equal(fetchCount, 2, "latest release metadata is checked on each online ensure");
      assert.equal(downloadCount, 1, "a verified release archive is reused");
      assert.equal(extractCount, 2, "a verified archive is freshly extracted without trusting old runtime files");
      assert.equal(fs.readFileSync(first, "utf8"), "fixture binary", "another invocation's extraction is untouched");

      const archivePath = path.join(cacheRoot, "mom", "vfixture", assetName);
      fs.rmSync(archivePath);
      const restored = await ensureMinerBinary("mom", options);
      assert.notEqual(restored, first);
      assert.equal(downloadCount, 2, "a digest-present cache without its archive is re-fetched");
      assert.equal(extractCount, 3, "a re-fetched archive produces a fresh extraction");

      fs.writeFileSync(archivePath, "tampered archive");
      const refreshed = await ensureMinerBinary("mom", options);
      assert.notEqual(refreshed, first);
      assert.equal(downloadCount, 3, "a digest mismatch forces a fresh archive download");
      assert.equal(extractCount, 4, "a digest mismatch produces a fresh extraction");
    } finally {
      if (previousDownload === undefined) delete process.env.MM_LIVE_DOWNLOAD;
      else process.env.MM_LIVE_DOWNLOAD = previousDownload;
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("keeps explicit offline mode on the existing cache without resolving a release", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-offline-cache-"));
    const previousRoot = process.env.MM_LIVE_MINER_ROOT;
    process.env.MM_LIVE_MINER_ROOT = cacheRoot;
    try {
      const binary = process.platform === "win32" ? "mom.cmd" : "mom";
      const cached = path.join(cacheRoot, "mom", "old-release", binary);
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(cached, "offline fixture");
      const previousDownload = process.env.MM_LIVE_DOWNLOAD;
      process.env.MM_LIVE_DOWNLOAD = "0";
      try {
        assert.equal(await ensureMinerBinary("mom"), cached);
      } finally {
        if (previousDownload === undefined) delete process.env.MM_LIVE_DOWNLOAD;
        else process.env.MM_LIVE_DOWNLOAD = previousDownload;
      }
    } finally {
      if (previousRoot === undefined) delete process.env.MM_LIVE_MINER_ROOT;
      else process.env.MM_LIVE_MINER_ROOT = previousRoot;
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("does not trust modified regular binaries or runtime dependencies beside a verified archive", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-extraction-integrity-"));
    const archiveBytes = "verified archive fixture";
    const spec = {api: "fixture", prefix: "fixture:", binary: "miner", asset: assets =>assets[0]};
    const options = {
      cacheRoot,
      extractionRoot: path.join(cacheRoot, "invocation"),
      ensureArchiveTools: () => {},
      fetchJson: async ()=>({tag_name: "vfixture", assets: [{name: "fixture.zip", browser_download_url: "fixture:archive",
        digest: `sha256:${crypto.createHash("sha256").update(archiveBytes).digest("hex")}`}]}),
      downloadToFile: async (_url, destination)=>fs.writeFileSync(destination, archiveBytes),
      refreshArchiveExtraction: async (_archive, destination) => {
        fs.mkdirSync(destination, {recursive: true});
        fs.writeFileSync(path.join(destination, "miner"), "verified binary");
        fs.writeFileSync(path.join(destination, "runtime.js"), "verified runtime");
      },
    };
    try {
      const first = await ensureReleaseAsset("fixture", spec, options);
      fs.writeFileSync(first, "modified binary");
      fs.writeFileSync(path.join(path.dirname(first), "runtime.js"), "modified runtime");
      const second = await ensureReleaseAsset("fixture", spec, options);
      assert.equal(fs.readFileSync(second, "utf8"), "verified binary");
      assert.equal(fs.readFileSync(path.join(path.dirname(second), "runtime.js"), "utf8"), "verified runtime");
      assert.notEqual(second, first);
      assert.equal(fs.readFileSync(first, "utf8"), "modified binary", "possibly active previous extraction is not replaced");
      assert.equal(fs.readFileSync(path.join(path.dirname(first), "runtime.js"), "utf8"), "modified runtime");
    } finally {
      fs.rmSync(cacheRoot, {recursive: true, force: true});
    }
  });

  it("passes resolved release paths through Intel and NVIDIA caller boundaries", () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-caller-cache-"));
    const previousRoot = process.env.MM_LIVE_MINER_ROOT;
    const previousMom = process.env.MOM_PATH;
    const previousSrb = process.env.SRBMINER_PATH;
    try {
      process.env.MM_LIVE_MINER_ROOT = cacheRoot;
      const momName = process.platform === "win32" ? "mom.cmd" : "mom";
      const srbName = process.platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI";
      const loaderName = "libxmrig-cuda.so";
      const oldMom = path.join(cacheRoot, "mom", "old-release", momName);
      const oldSrb = path.join(cacheRoot, "srbminer-multi", "old-release", srbName);
      const oldLoader = path.join(cacheRoot, "xmrig-cuda", "old-release", loaderName);
      const currentMom = path.join(cacheRoot, "mom", "vfixture", momName);
      const currentSrb = path.join(cacheRoot, "srbminer-multi", "vfixture", srbName);
      const currentLoader = path.join(cacheRoot, "xmrig-cuda", "vfixture", loaderName);
      for (const file of [oldMom, oldSrb, oldLoader, currentMom, currentSrb, currentLoader]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "fixture");
      }
      const future = new Date(Date.now() + 60_000);
      for (const file of [oldMom, oldSrb, oldLoader]) fs.utimesSync(file, future, future);

      const resolved = {
        mom: currentMom,
        "srbminer-multi": currentSrb,
        "xmrig-cuda": currentLoader,
      };
      const intel = resolveMinerPaths(resolved);
      assert.equal(intel.mom, currentMom);
      assert.equal(intel.srbminer, currentSrb);

      const command = scriptCommand("srbminer-multi", "./SRBMiner-MULTI --version", resolved);
      assert.ok(command.includes(path.dirname(currentSrb)));
      assert.ok(!command.includes(path.dirname(oldSrb)), "NVIDIA command setup must not select an older release");

      const context = minerCommandContext({ cudaBinary: "xmrig-cuda/libxmrig-cuda.so" }, cacheRoot, resolved);
      assert.equal(context.xmrigCudaLoader, currentLoader);

      const failedIntel = resolveMinerPaths({ ...resolved, mom: "", "srbminer-multi": "" });
      assert.equal(failedIntel.mom, "", "a failed Intel release refresh must not fall back to an old binary");
      assert.equal(failedIntel.srbminer, "", "a failed SRBMiner refresh must not fall back to an old binary");
      const failedCommand = scriptCommand("srbminer-multi", "./SRBMiner-MULTI --version", {
        ...resolved,
        "srbminer-multi": "",
      });
      assert.equal(failedCommand, "", "a failed NVIDIA release refresh must not build an old command");
      const failedContext = minerCommandContext({ cudaBinary: "xmrig-cuda/libxmrig-cuda.so" }, cacheRoot, {
        ...resolved,
        "xmrig-cuda": "",
      });
      assert.equal(failedContext.xmrigCudaLoader, "", "a failed CUDA refresh must not load an old plugin");
      assert.equal(resolveMinerPaths({ ...resolved, mom: path.join(cacheRoot, "missing-mom") }).mom, "",
        "an invalid resolved path must not fall back to an old binary");

      const overrideMom = path.join(cacheRoot, "override", momName);
      const overrideSrb = path.join(cacheRoot, "override", srbName);
      fs.mkdirSync(path.dirname(overrideMom), { recursive: true });
      fs.writeFileSync(overrideMom, "override");
      fs.writeFileSync(overrideSrb, "override");
      process.env.MOM_PATH = overrideMom;
      process.env.SRBMINER_PATH = overrideSrb;
      const overridden = resolveMinerPaths(resolved);
      assert.equal(overridden.mom, overrideMom);
      assert.equal(overridden.srbminer, overrideSrb);
    } finally {
      if (previousRoot === undefined) delete process.env.MM_LIVE_MINER_ROOT;
      else process.env.MM_LIVE_MINER_ROOT = previousRoot;
      if (previousMom === undefined) delete process.env.MOM_PATH;
      else process.env.MOM_PATH = previousMom;
      if (previousSrb === undefined) delete process.env.SRBMINER_PATH;
      else process.env.SRBMINER_PATH = previousSrb;
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects escaping and composed symlink targets before extraction", posixArchive, async () => {
    const cases = [
      (source) => {
        fs.mkdirSync(path.join(source, "pkg"));
        fs.symlinkSync("../../outside", path.join(source, "pkg", "escape"));
      },
      (source) => {
        fs.mkdirSync(path.join(source, "pkg"));
        fs.symlinkSync("..", path.join(source, "pkg", "a"));
        fs.symlinkSync("a/../outside", path.join(source, "pkg", "b"));
      },
    ];
    for (const prepare of cases) {
      const fixture = createArchiveFixture({ archiveName: "unsafe.tar", prepare });
      try {
        await assert.rejects(fixtureEnsure(fixture), /Unsafe archive link|Broken archive link/);
        assert.equal(fs.existsSync(fixture.extractDir), false, "invalid links must fail before extraction");
      } finally {
        removeFixture(fixture);
      }
    }
  });

  it("rejects cyclic and over-budget acyclic link graphs before extraction", posixArchive, async () => {
    const cycle = createArchiveFixture({
      archiveName: "cycle.tar",
      prepare: (source) => {
        fs.symlinkSync("cycle-b", path.join(source, "cycle-a"));
        fs.symlinkSync("cycle-a", path.join(source, "cycle-b"));
      },
    });
    try {
      await assert.rejects(fixtureEnsure(cycle), /Unsafe archive link cycle/);
      assert.equal(fs.existsSync(cycle.extractDir), false);
    } finally {
      removeFixture(cycle);
    }

    const overBudget = createArchiveFixture({
      archiveName: "over-budget.tar",
      prepare: (source) => {
        fs.writeFileSync(path.join(source, "mom"), "fixture binary");
        for (let index = 0; index < 1025; index += 1) {
          const name = `link-${String(index).padStart(4, "0")}`;
          const target = index === 1024 ? "mom" : `link-${String(index + 1).padStart(4, "0")}`;
          fs.symlinkSync(target, path.join(source, name));
        }
      },
    });
    try {
      await assert.rejects(fixtureEnsure(overBudget), /Unsafe archive link cycle/);
      assert.equal(fs.existsSync(overBudget.extractDir), false);
    } finally {
      removeFixture(overBudget);
    }
  });

  it("accepts a finite symlink revisit after its first expansion is complete", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "finite-revisit.tar",
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "dir"), { recursive: true });
        fs.writeFileSync(path.join(source, "dir", "mom"), "fixture binary");
        fs.symlinkSync("dir", path.join(source, "a"));
        fs.symlinkSync("a/../a/mom", path.join(source, "b"));
      },
    });
    try {
      const binary = await fixtureEnsure(fixture);
      assert.equal(fs.statSync(binary).isFile(), true);
    } finally {
      removeFixture(fixture);
    }
  });

  it("accepts a regular member reached through a confined symlink parent", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "symlink-parent.tar",
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "target"), { recursive: true });
        fs.writeFileSync(path.join(source, "target", "mom"), "fixture binary");
        fs.symlinkSync("target", path.join(source, "pkg"));
      },
    });
    try {
      const binary = await fixtureEnsure(fixture);
      assert.equal(fs.statSync(binary).isFile(), true);
      assert.equal(fs.lstatSync(path.join(fixture.extractDir, "pkg")).isSymbolicLink(), true);
    } finally {
      removeFixture(fixture);
    }
  });

  it("rejects a link declared through a symlink parent before tar extraction", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "physical-parent-escape.tar",
      prepare: () => {},
      archiveBuilder: ({ root, archive }) => {
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        fs.mkdirSync(first, { recursive: true });
        fs.mkdirSync(path.join(second, "a"), { recursive: true });
        fs.mkdirSync(path.join(second, "b", "x"), { recursive: true });
        fs.symlinkSync("b", path.join(first, "a"));
        fs.symlinkSync("../../escape", path.join(second, "a", "x"));
        fs.writeFileSync(path.join(second, "b", "x", "payload"), "fixture payload");
        childProcess.execFileSync("tar", ["-cf", archive, "-C", first, "a"], { stdio: "ignore" });
        childProcess.execFileSync("tar", ["-rf", archive, "-C", second, "b"], { stdio: "ignore" });
        childProcess.execFileSync("tar", ["-rf", archive, "-C", second, "a/x"], { stdio: "ignore" });
      },
    });
    try {
      await withTarExtractionCounter(fixture, async (marker) => {
        await assert.rejects(fixtureEnsure(fixture), /Unsafe archive link|Broken archive link/);
        assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "", "",
          "unsafe physical aliases must fail before tar extraction");
      });
      assert.equal(fs.existsSync(fixture.extractDir), false);
    } finally {
      removeFixture(fixture);
    }
  });

  it("rejects ambiguous tar link metadata before extraction", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "ambiguous-link.tar",
      prepare: (source) => {
        fs.writeFileSync(path.join(source, "mom"), "fixture binary");
        fs.mkdirSync(path.join(source, "a -> .."));
        fs.writeFileSync(path.join(source, "a -> ..", "outside"), "matching member suffix");
        fs.writeFileSync(path.join(source, "a -> ..", "safe"), "confined decoy target");
        fs.symlinkSync("../outside -> safe", path.join(source, "a"));
      },
    });
    try {
      await withTarExtractionCounter(fixture, async (marker) => {
        await assert.rejects(fixtureEnsure(fixture), /Unparseable archive link/);
        assert.equal(fs.existsSync(marker), false, "ambiguous link metadata must fail before extraction");
      });
    } finally {
      removeFixture(fixture);
    }
  });

  it("rejects an over-budget hardlink chain before extraction", posixArchive, async () => {
    const patches = [];
    const fixture = createArchiveFixture({
      archiveName: "hardlink-chain.tar",
      prepare: (source) => {
        const targetPath = path.join(source, "zz-target");
        fs.writeFileSync(targetPath, "fixture binary");
        fs.linkSync(targetPath, path.join(source, "mom"));
        for (let index = 0; index < 1025; index += 1) {
          const name = `hard-${String(index).padStart(4, "0")}`;
          fs.linkSync(targetPath, path.join(source, name));
          if (index < 1024) {
            patches.push({
              member: name,
              target: index === 1023 ? "zz-target" : `hard-${String(index + 1).padStart(4, "0")}`,
            });
          }
        }
        patches.push({ member: "mom", target: "hard-0000" });
      },
      patchTarTargets: patches,
    });
    try {
      await assert.rejects(fixtureEnsure(fixture), /Unsafe archive link cycle/);
      assert.equal(fs.existsSync(fixture.extractDir), false);
    } finally {
      removeFixture(fixture);
    }
  });

  it("rejects a hardlink target outside the archive root before extraction", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "hardlink.tar",
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "pkg"));
        fs.writeFileSync(path.join(source, "mom"), "fixture binary");
        fs.linkSync(path.join(source, "mom"), path.join(source, "pkg", "bad"));
      },
      patchTarTarget: { member: "pkg/bad", target: "../outside" },
    });
    try {
      await assert.rejects(fixtureEnsure(fixture), /Unsafe archive (link|hardlink) target/);
      assert.equal(fs.existsSync(fixture.extractDir), false);
    } finally {
      removeFixture(fixture);
    }
  });

  it("accepts genuine in-tree links and isolates an invalid previous extraction", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "linked.tar",
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "bin"), { recursive: true });
        fs.mkdirSync(path.join(source, "pkg"), { recursive: true });
        fs.mkdirSync(path.join(source, "space name"), { recursive: true });
        fs.writeFileSync(path.join(source, "bin", "mom"), "fixture binary");
        fs.symlinkSync("../bin/mom", path.join(source, "pkg", "link"));
        fs.linkSync(path.join(source, "bin", "mom"), path.join(source, "pkg", "hard"));
        fs.writeFileSync(path.join(source, "space name", "data"), "space");
      },
    });
    try {
      const first = await fixtureEnsure(fixture);
      assert.equal(fs.statSync(first).isFile(), true);
      assert.equal(fs.lstatSync(path.join(fixture.extractDir, "pkg", "link")).isSymbolicLink(), true);
      assert.equal(fs.statSync(path.join(fixture.extractDir, "pkg", "hard")).ino,
        fs.statSync(first).ino, "in-tree hardlink must remain confined to the extracted tree");

      fs.unlinkSync(path.join(fixture.extractDir, "pkg", "link"));
      fs.symlinkSync("../../outside", path.join(fixture.extractDir, "pkg", "link"));
      const previousDir = fixture.extractDir;
      const repaired = await fixtureEnsure(fixture);
      assert.equal(fs.lstatSync(repaired).isSymbolicLink(), false, "cache hit must not return a link");
      assert.equal(fs.statSync(path.join(fixture.extractDir, "pkg", "link")).isSymbolicLink(), false,
        "fresh extraction must not inherit invalid previous links");
      assert.equal(fs.readlinkSync(path.join(previousDir, "pkg", "link")), "../../outside", "previous tree remains untouched");
    } finally {
      removeFixture(fixture);
    }
  });

  it("accepts DOS-compatible ZIP metadata and names containing spaces", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "space names.ZIP",
      zip: true,
      dosZip: true,
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "dir with space"), { recursive: true });
        fs.writeFileSync(path.join(source, "dir with space", "mom"), "fixture binary");
      },
    });
    try {
      const binary = await fixtureEnsure(fixture);
      assert.equal(fs.statSync(binary).isFile(), true);
      assert.equal(binary.endsWith(path.join("dir with space", "mom")), true);
    } finally {
      removeFixture(fixture);
    }
  });

  it("preserves a valid cached extraction when replacement preflight fails", posixArchive, async () => {
    const fixture = createArchiveFixture({
      archiveName: "replacement.tar",
      prepare: (source) => {
        fs.mkdirSync(path.join(source, "pkg"));
        fs.symlinkSync("../../outside", path.join(source, "pkg", "escape"));
      },
    });
    const cachedBinary = path.join(fixture.extractDir, "mom");
    try {
      fs.mkdirSync(fixture.extractDir, { recursive: true });
      fs.writeFileSync(cachedBinary, "known-good cached binary");
      await assert.rejects(fixtureEnsure(fixture), /Unsafe archive link|Broken archive link/);
      assert.equal(fs.readFileSync(cachedBinary, "utf8"), "known-good cached binary");
    } finally {
      removeFixture(fixture);
    }
  });
});
