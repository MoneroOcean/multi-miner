
### Usage example with gminer on Linux

* Get Meta Miner:

```shell
sudo apt-get update
sudo apt-get install -y nodejs
wget https://raw.githubusercontent.com/MoneroOcean/meta-miner/master/mm.js
chmod +x mm.jschmod +x''
* Get gminer (and gminer v.2.39 for c29v algo support):
core_dir
```shell
wget https://github.com/develsoftware/GMinerRelease/releases/download/2.42/gminer_2_42_linux64.tar.xz
mkdir gminer
(cd gminer && tar xf ../gminer_2_42_linux64.tar.xz)
wget https://github.com/develsoftware/GMinerRelease/releases/download/2.39/gminer_2_39_linux64.tar.xz
mkdir gminer39
(cd gminer39 && tar xf ../gminer_2_39_linux64.tar.xz)
```

* Run Meta Miner:

```shell
export GMINER_COMMON="--server localhost:3333 --user 89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL --pass gpu_miner"
export GMINER_LAST="gminer/miner $GMINER_COMMON"
export GMINER_39="gminer39/miner $GMINER_COMMON"
./mm.js -p=gulf.moneroocean.stream:11024 --ethash="$GMINER_LAST --algo ethash --proto stratum" --kawpow="$GMINER_LAST --algo kawpow" --c29s="$GMINER_LAST --algo cuckaroo29s" --c29b="$GMINER_LAST --algo cuckaroo29b" --c29v="$GMINER_39 --algo cuckarood29v"
```
