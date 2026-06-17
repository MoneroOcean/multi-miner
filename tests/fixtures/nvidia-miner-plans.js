"use strict";

const fs = require("fs");
const path = require("path");
const { words } = require("../common/live-helpers");

function nvidiaMinerPlans(scriptCommand, wallet) {
  const srb = (command) => scriptCommand("srbminer-multi", `./SRBMiner-MULTI ${  command  } --retry-time 1 --job-timeout 0 --gpu-sensors-disable --disable-worker-watchdog`);
  const stableGpuArgs = "--gpu-intensity 1 --gpu-disable-interleaving --disable-gpu-dual-kernels --autotune-no-load --busy-wait-recheck 0.01 --extended-log";
  const gpuFlags = "--disable-cpu --disable-gpu-amd --disable-gpu-intel --gpu-id 0";
  return [
    {
      name: "xmrig-cuda-rx-0",
      algo: "rx/0",
      binary: "xmrig-mo/xmrig",
      cudaBinary: "xmrig-cuda/libxmrig-cuda.so",
      kind: "default",
      command: (port, context = {}) => {
        if (!context.xmrigCudaLoader || !context.tmpDir) return "";
        const configPath = path.join(context.tmpDir, "xmrig-cuda-config.json");
        fs.writeFileSync(configPath, JSON.stringify(xmrigCudaConfig(context.xmrigCudaLoader), null, 2));
        return scriptCommand("xmrig-mo", `LD_LIBRARY_PATH=${quote(path.dirname(context.xmrigCudaLoader))}:$LD_LIBRARY_PATH ./xmrig -c ${quote(configPath)} -o 127.0.0.1:${port} -u ${wallet} -p x --coin monero --no-color --donate-level=1 --no-cpu --cuda --cuda-loader=${quote(context.xmrigCudaLoader)} --cuda-devices=0 --bench-algo-time=0`);
      },
    },
    {
      name: "srbminer-cn-gpu",
      algo: "cn/gpu",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "default",
      command: (port) => srb(`--algorithm cryptonight_gpu --pool 127.0.0.1:${port} --wallet ${wallet} --password x ${gpuFlags} ${stableGpuArgs}`),
    },
    {
      name: "srbminer-autolykos2",
      algo: "autolykos2",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "eth",
      command: (port) => srb(`--algorithm autolykos2 --pool 127.0.0.1:${port} --wallet ${wallet} --password x ${gpuFlags} ${stableGpuArgs}`),
    },
    {
      name: "srbminer-etchash",
      algo: "etchash",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "eth",
      command: (port) => srb(`--algorithm etchash --pool 127.0.0.1:${port} --wallet ${wallet} --password x --esm 1 ${gpuFlags}`),
    },
    {
      name: "srbminer-etchash-ethstratum2",
      algo: "etchash",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "eth",
      command: (port) => srb(`--algorithm etchash --pool 127.0.0.1:${port} --wallet ${wallet} --password x --esm 2 ${gpuFlags}`),
    },
    {
      name: "srbminer-etchash-ethproxy",
      algo: "etchash",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "eth",
      command: (port) => srb(`--algorithm etchash --pool 127.0.0.1:${port} --wallet ${wallet} --password x --esm 0 ${gpuFlags}`),
    },
    {
      name: "srbminer-kawpow",
      algo: "kawpow",
      binary: "srbminer-multi/SRBMiner-MULTI",
      kind: "eth",
      command: (port) => srb(`--algorithm kawpow --pool 127.0.0.1:${port} --wallet ${wallet} --password x ${gpuFlags}`),
    },
    {
      name: "lolminer-autolykos2",
      algo: "autolykos2",
      binary: "lolminer/lolMiner",
      kind: "eth",
      command: (port) => scriptCommand("lolminer", `./lolMiner --algo AUTOLYKOS2 --pool 127.0.0.1:${port} --user ${wallet} --pass x --nocolor`),
    },
    {
      name: "lolminer-etchash",
      algo: "etchash",
      binary: "lolminer/lolMiner",
      kind: "eth",
      command: (port) => scriptCommand("lolminer", `./lolMiner --algo ETCHASH --pool 127.0.0.1:${port} --user ${wallet} --pass x --ethstratum ETHV1 --nocolor`),
    },
    {
      name: "lolminer-etchash-ethproxy",
      algo: "etchash",
      binary: "lolminer/lolMiner",
      kind: "eth",
      command: (port) => scriptCommand("lolminer", `./lolMiner --algo ETCHASH --pool 127.0.0.1:${port} --user ${wallet} --pass x --ethstratum ETHPROXY --nocolor`),
    },
    {
      name: "lolminer-c29",
      algo: "c29",
      binary: "lolminer/lolMiner",
      kind: "default",
      command: (port) => scriptCommand("lolminer", `./lolMiner --algo CR29 --pool 127.0.0.1:${port} --user ${wallet} --pass x --nocolor`),
    },
    ...["autolykos2", "etchash", "kawpow"].map((algo) => ({
      name: `gminer-${  algo}`,
      algo,
      binary: "gminer/miner",
      kind: "eth",
      command: (port) => scriptCommand("gminer", `./miner --algo ${algo} --server 127.0.0.1 --port ${port} --user ${wallet} --pass x --proto stratum`),
    })),
    ...["autolykos2", "etchash", "kawpow"].map((algo) => ({
      name: `rigel-${  algo}`,
      algo,
      binary: "rigel/rigel",
      kind: "eth",
      command: (port) => scriptCommand("rigel", `./rigel -a ${algo} -o stratum+tcp://127.0.0.1:${port} -u ${wallet} -p x --no-tui`),
    })),
    ...[
      ["trex-autolykos2", "autolykos2", "stratum"],
      ["trex-etchash", "etchash", "stratum"],
      ["trex-etchash-stratum2", "etchash", "stratum2"],
      ["trex-kawpow", "kawpow", "stratum"],
    ].map(([name, algo, protocol]) => ({
      name,
      algo,
      binary: "trex/t-rex",
      kind: "eth",
      command: (port) => scriptCommand("trex", `./t-rex -a ${algo} -o ${protocol}+tcp://127.0.0.1:${port} -u ${wallet} -p x --no-watchdog --no-color`),
    })),
  ];
}

function xmrigCudaConfig(loader) {
  return {
    autosave: false,
    "algo-min-time": 0,
    "bench-algo-time": 0,
    "rebench-algo": false,
    "algo-perf": Object.fromEntries(words("argon2/chukwav2 cn-heavy/xhv cn/half cn/gpu cn-lite/1 cn-pico cn-pico/trtl cn/r cn/ccx flex ghostrider kawpow panthera rx/0 rx/arq rx/graft rx/wow")
      .map((algo) => [algo, 1])),
    cpu: false,
    cuda: {
      enabled: true,
      loader,
      devices: [0],
    },
  };
}

function quote(value) {
  return `'${  String(value).replace(/'/g, "'\\''")  }'`;
}

module.exports = { nvidiaMinerPlans };
