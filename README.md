# Multi-Miner

Multi-Miner adds MoneroOcean-style algorithm switching support to stratum
miners that do not implement pool-side algo switching themselves. It runs a
local stratum endpoint for your miner, connects to one or more upstream pools,
and starts the configured miner command for each algorithm requested by the
pool.

Multi-Miner does not add a mining fee. The project remains GPLv3.

## Quick Start

Release binaries are OS and CPU architecture specific:

| Platform | Binary |
| --- | --- |
| Windows x64 | `mm.exe` |
| Linux x64 | `mm` |
| Linux arm64 | `mm` |
| macOS Intel x64 | `mm` |
| macOS arm64 | `mm` |

Download the archive for your platform, unpack it beside your miner, and point
the miner at Multi-Miner's local pool, usually `127.0.0.1:3333`.

Windows:

```powershell
.\mm.exe -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x --rx/0="xmrig.exe --config=config.json"
```

Linux and macOS:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x --rx/0="./xmrig --config=config.json"
```

Source compatibility is kept. You can still run `mm.js` directly:

```sh
node mm.js -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x --rx/0="./xmrig --config=config.json"
```

## Configuration

Multi-Miner keeps the historical `mm.json` config format and all existing CLI
option names. If no command line options are supplied, `mm.json` in the current
directory is loaded.

Minimal `mm.json`:

```json
{
  "miner_host": "127.0.0.1",
  "miner_port": 3333,
  "pools": ["gulf.moneroocean.stream:ssl20128"],
  "algos": {
    "rx/0": "./xmrig --config=config.json",
    "cn/gpu": "./SRBMiner-MULTI --algorithm cryptonight_gpu --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu",
    "etchash": "./SRBMiner-MULTI --algorithm etchash --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu"
  },
  "algo_perf": {
    "rx/0": 1000,
    "cn/gpu": 1000,
    "etchash": 50000000
  },
  "user": "YOUR_XMR_WALLET",
  "pass": "x",
  "watchdog": 600,
  "hashrate_watchdog": 0
}
```

Useful options:

```text
--pool=<host:port> (-p)             Adds a pool. Use sslPORT or tlsPORT for TLS.
--host=<hostname>                   Local miner bind host. Default: 127.0.0.1.
--port=<number>                     Local miner bind port. Default: 3333.
--user=<wallet> (-u)                Pool login. Uses first miner login if omitted.
--pass=<worker>                     Pool password/worker. Uses first miner pass if omitted.
--miner=<command> (-m)              Smart miner that reports supported algorithms.
--<algo>=<command>                  Miner command for one algorithm.
--perf_<algo>=<hashrate>            Expected hashrate; use 0 to benchmark again.
--algo_min_time=<seconds>           Minimum time pool should keep one algorithm.
--watchdog=<seconds> (-w)           Restart miner after no submits; 0 disables.
--hashrate_watchdog=<percent>       Restart if reported hashrate drops below threshold.
--miner_stdin                       Inherit stdin for miner processes.
--diagnostics                       Validate config and exit.
--quiet (-q), --verbose (-v), --debug
--log=<file>, --no-config-save, --help
```

Current MoneroOcean GPU algorithms covered by Multi-Miner metadata include
`autolykos2`, `c29`, `cn/gpu`, `etchash`, and `kawpow`.

## MoneroOcean Examples

For MoneroOcean TLS, use `gulf.moneroocean.stream:ssl20128` in Multi-Miner.
Miner commands should still connect to Multi-Miner locally without TLS at
`127.0.0.1:3333`.

These examples keep only the options needed for Multi-Miner and MoneroOcean
compatibility. Add device selection, clocks, logging, API, or tuning options in
your miner config when needed for your rig.

### Through Multi-Miner

XMRig smart miner:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  -m="./xmrig -o 127.0.0.1:3333 -u YOUR_XMR_WALLET -p x"
```

SRBMiner-Multi for `cn/gpu`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_cn/gpu=1000 \
  --cn/gpu="./SRBMiner-MULTI --algorithm cryptonight_gpu --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu"
```

SRBMiner-Multi for `autolykos2`, `etchash`, and `kawpow`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_autolykos2=100000000 --perf_etchash=50000000 --perf_kawpow=0.01 \
  --autolykos2="./SRBMiner-MULTI --algorithm autolykos2 --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu" \
  --etchash="./SRBMiner-MULTI --algorithm etchash --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu" \
  --kawpow="./SRBMiner-MULTI --algorithm kawpow --pool 127.0.0.1:3333 --wallet YOUR_XMR_WALLET --password x --disable-cpu"
```

For SRBMiner Etchash `--esm 0`, Multi-Miner accepts the initial `eth_getWork`
request and forwards pushed getWork-style job refreshes from the pool, so stale
`block expired` loops are not hidden behind the local proxy.

lolMiner for `autolykos2`, `etchash`, and `c29`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_autolykos2=100000000 --perf_etchash=50000000 --perf_c29=1 \
  --autolykos2="./lolMiner --algo AUTOLYKOS2 --pool 127.0.0.1:3333 --user YOUR_XMR_WALLET --pass x" \
  --etchash="./lolMiner --algo ETCHASH --pool 127.0.0.1:3333 --user YOUR_XMR_WALLET --pass x" \
  --c29="./lolMiner --algo CR29 --pool 127.0.0.1:3333 --user YOUR_XMR_WALLET --pass x"
```

GMiner for `autolykos2`, `etchash`, and `kawpow`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_autolykos2=100000000 --perf_etchash=50000000 --perf_kawpow=0.01 \
  --autolykos2="./miner --algo autolykos2 --server 127.0.0.1 --port 3333 --user YOUR_XMR_WALLET --pass x --proto stratum" \
  --etchash="./miner --algo etchash --server 127.0.0.1 --port 3333 --user YOUR_XMR_WALLET --pass x --proto stratum" \
  --kawpow="./miner --algo kawpow --server 127.0.0.1 --port 3333 --user YOUR_XMR_WALLET --pass x --proto stratum"
```

Rigel for `autolykos2`, `etchash`, and `kawpow`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_autolykos2=100000000 --perf_etchash=50000000 --perf_kawpow=0.01 \
  --autolykos2="./rigel -a autolykos2 -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x" \
  --etchash="./rigel -a etchash -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x" \
  --kawpow="./rigel -a kawpow -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x"
```

T-Rex for `autolykos2`, `etchash`, and `kawpow`:

```sh
./mm -p=gulf.moneroocean.stream:ssl20128 -u=YOUR_XMR_WALLET --pass=x \
  --perf_autolykos2=100000000 --perf_etchash=50000000 --perf_kawpow=0.01 \
  --autolykos2="./t-rex -a autolykos2 -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x" \
  --etchash="./t-rex -a etchash -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x" \
  --kawpow="./t-rex -a kawpow -o stratum+tcp://127.0.0.1:3333 -u YOUR_XMR_WALLET -p x"
```

### Direct To MoneroOcean

Direct miner commands are a reference for checking miner and MoneroOcean pool
compatibility. They pin the miner to one algorithm, show the miner-specific TLS
or stratum mode syntax, and pass the fixed algorithm in the password as
`WORKER~algo`. Use Multi-Miner when you want MoneroOcean to switch between
different miner commands.

In most cases, start from the Multi-Miner example and replace Multi-Miner's
local `127.0.0.1:3333` pool with the direct MoneroOcean TLS endpoint. The
useful differences are the pool URL syntax and any miner-specific protocol
mode:

```sh
XMRig:          -o gulf.moneroocean.stream:20128 --tls -p worker~rx/0
SRBMiner-Multi: --pool gulf.moneroocean.stream:20128 --tls true --password worker~cn/gpu
GMiner:         --server gulf.moneroocean.stream --port 20128 --ssl 1 --pass worker~etchash --proto stratum
lolMiner:       --pool gulf.moneroocean.stream:20128 --tls on --pass worker~etchash --ethstratum ETHV1
T-Rex:          -o stratum2+ssl://gulf.moneroocean.stream:20128 -p worker~kawpow --no-strict-ssl
Rigel:          -o stratum+ssl://gulf.moneroocean.stream:20128 -p worker~kawpow --no-strict-ssl
```

For lolMiner Etchash, both `--ethstratum ETHV1` and `--ethstratum ETHPROXY`
worked in direct testing. SRBMiner-Multi Etchash direct testing against
`sg.moneroocean.stream` accepted shares with `--esm 1`, `--esm 2`, and
`--esm 0`.

## Benchmarking And Hashrate

If `algo_perf` is missing or set to `0` for a configured benchmark algorithm,
Multi-Miner starts the miner against a local fake job and reads hashrate from
miner output. Hashrate parsing includes common formats from XMRig, xmr-stak,
SRBMiner-Multi, lolMiner, GMiner, Rigel, T-Rex, TeamRedMiner, Team Black Miner,
CryptoDredge, Claymore, and legacy formats.

For specific re-benchmarking:

```sh
./mm --perf_rx/0=0 --perf_cn/gpu=0
```

## Diagnostics

Validate a config without connecting to an external pool:

```sh
./mm mm.json --diagnostics
node mm.js mm.json --diagnostics
```

Common checks:

```sh
./mm --help
./mm mm.json --verbose --debug
```

Troubleshooting notes:

- Configure every miner to connect to Multi-Miner, not directly to the remote pool.
- Use a unique `--port` for each Multi-Miner instance on the same host.
- Keep quotes around miner commands that contain spaces.
- Use backup pools by specifying `--pool` more than once.
- Set `--watchdog=0` while debugging miner startup.
- Use `--no-config-save` for temporary CLI-only test runs.

## Development

Requirements:

- Node.js 18 or newer for source usage and tests.
- Network access only for installing build tooling or contacting real pools.

Install the pinned development toolchain from the committed lockfile:

```sh
npm ci
```

Run tests:

```sh
npm test
npm run quality
npm run audit
```

Run all optional local live tests. These use fake localhost pools only and
skip unavailable hardware. Missing supported miner distributions are downloaded
into this repo's `.cache/live-miners` cache before the cases run. Every runnable
case waits for a real share submit to the fake pool. C29 can take several
minutes even at the lowest fake difficulty; override `MM_LIVE_C29_TIMEOUT_MS`
if needed:

```sh
npm run test:live
```

Set `MM_LIVE_DOWNLOAD=0` to disable live miner downloads and only use binaries
already present in the local cache or specified by path overrides.

Run the optional CPU live test. It uses only a fake localhost pool and downloads
MoneroOcean XMRig into the local live cache when needed:

```sh
npm run test:live:cpu
XMRIG_PATH=/path/to/xmrig MM_LIVE_CPU_CASES=xmrig-rx-0,xmrig-panthera npm run test:live:cpu
```

Run the optional local Intel GPU live test. It uses only a fake localhost pool
and skips if SRBMiner, MoMiner, an algorithm, or an Intel OpenCL GPU is unavailable.
SRBMiner-Multi and MoMiner are downloaded into this repo's `.cache/live-miners`
cache when needed. Override with `MM_LIVE_CACHE_DIR` or a miner-specific path:

```sh
npm run test:live:intel-gpu
SRBMINER_PATH=/path/to/SRBMiner-MULTI npm run test:live:intel-gpu
MOMINER_PATH=/path/to/mominer MM_LIVE_MOMINER_C29_DEVICE=gpu1*1 npm run test:live:intel-gpu
MM_LIVE_INTEL_GPU_CASES=srbminer-cn-gpu,mominer-c29 npm run test:live:intel-gpu
```

Run the optional NVIDIA GPU miner matrix. It also uses fake localhost pools only
and downloads supported miner distributions into this repo's `.cache/live-miners`
cache when needed. Each passed case prints the miner protocol Multi-Miner observed
(`default`, `eth`, `ethproxy`, or `grin`) so ETH-proxy and non-ETH-proxy modes
are checked explicitly:

```sh
MM_LIVE_MINER_ROOT=/path/to/miners npm run test:live:nvidia-gpu
MM_LIVE_NVIDIA_GPU_MINERS=trex-etchash,rigel-kawpow npm run test:live:nvidia-gpu
MM_LIVE_NVIDIA_GPU_MINERS=srbminer-etchash,srbminer-etchash-ethstratum2,srbminer-etchash-ethproxy,trex-etchash,trex-etchash-stratum2 npm run test:live:nvidia-gpu
```

The NVIDIA `xmrig-cuda-rx-0` live case needs the MoneroOcean XMRig fork and the
MoneroOcean `xmrig-cuda` plugin. Put them under the live miner cache as
`xmrig-mo/.../xmrig` and `xmrig-cuda/.../libxmrig-cuda.so`, or point
`MM_LIVE_MINER_ROOT` at a directory with that layout. The CUDA plugin must be
built for the installed NVIDIA driver/GPU and must be able to load its CUDA
runtime dependencies; either install the matching CUDA runtime system-wide or
place libraries such as `libnvrtc.so.*` beside `libxmrig-cuda.so`.

Build the current platform binary:

```sh
npm run build:current
```

Build all release targets:

```sh
npm run build:release
```

The release workflow publishes clean per-platform archives containing only the
binary, `README.md`, `LICENSE`, and user documentation files. Source, tests,
CI metadata, caches, and development artifacts are excluded from release
archives.
