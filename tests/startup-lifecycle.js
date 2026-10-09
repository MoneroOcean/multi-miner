'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const { EventEmitter, once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const { MultiMinerApp } = require('../mm');
const { formatCommand } = require('../src/command');
const { runSequential } = require('../src/process-manager');
const { silentLogger } = require('./common/helpers');

function timeout(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Lifecycle operation timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function startupLogger() {
  return { ...silentLogger(), miner() {} };
}

describe('Startup and CLI shutdown', { concurrency: false }, () => {
  it('accepts miner output through the startup logger fixture', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-startup-logger-'));
    const app = new MultiMinerApp([], { cwd: dir });
    app.logger = startupLogger();
    t.after(async () => {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.doesNotThrow(() => app.printAllMessages('fixture startup output\n'));
  });
  it('does not advance a cancelled sequential queue', () => {
    let stopping = false;
    let started = 0;
    let completed = 0;
    runSequential([
      (next) => { started++; stopping = true; next(); },
      (next) => { started++; next(); },
    ], () => { completed++; }, () => stopping);
    assert.equal(started, 1);
    assert.equal(completed, 1);
  });

  for (const phase of ['check', 'benchmark']) {
    it(`owns and closes the ${phase} child before stop resolves`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-startup-'));
      const app = new MultiMinerApp([], { cwd: dir, checkTimeoutMs: 120, benchmarkTimeoutMs: 120 });
      app.logger = startupLogger();
      const children = [];
      const start = app.startMinerProcess.bind(app);
      app.startMinerProcess = (...args) => {
        const proc = start(...args);
        if (proc) children.push(proc);
        return proc;
      };
      t.after(async () => {
        await app.stop();
        for (const proc of children) {
          if (proc.exitCode === null && proc.signalCode === null) {
            const closed = once(proc, 'close');
            proc.kill();
            await timeout(closed);
          }
        }
        if (running) await timeout(running);
        fs.rmSync(dir, { recursive: true, force: true });
      });

      const command = formatCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      app.config.algos = { 'cn/gpu': command, etchash: command };
      const running = phase === 'check'
        ? app.checkMiners({ miners: app.config.algos, smartMiners: [] })
        : app.runBenchmarks();
      const proc = children[0];
      await once(proc, 'spawn');
      const tracked = app.minerProc === proc;
      const stopped = app.stop();
      const sameStop = app.stop();
      await timeout(stopped);
      const childClosedBeforeStop = proc.exitCode !== null || proc.signalCode !== null;
      await timeout(running);

      assert.equal(tracked, true, 'Startup child must use the active miner slot');
      assert.equal(childClosedBeforeStop, true, 'Stop must wait for the owned child to exit');
      assert.equal(stopped, sameStop, 'Concurrent stops must share one shutdown');
      assert.equal(children.length, 1, 'Shutdown must not start the next child');
      assert.equal(app.benchmarkAlgo, null);
    });

    it(`clears the ${phase} timeout when its child exits early`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-startup-exit-'));
      const app = new MultiMinerApp([], { cwd: dir, checkTimeoutMs: 700, benchmarkTimeoutMs: 700 });
      app.logger = startupLogger();
      app.config.algos = { 'cn/gpu': 'unused' };
      app.startMinerProcess = () => {
        const proc = new EventEmitter();
        proc.exitCode = proc.signalCode = null;
        queueMicrotask(() => { proc.exitCode = 7; proc.emit('close', 7); });
        return proc;
      };
      let completed = false;
      const running = (phase === 'check'
        ? app.checkMiners({ miners: app.config.algos, smartMiners: [] })
        : app.runBenchmarks()).then(() => { completed = true; });
      t.after(async () => {
        await timeout(running);
        await app.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(completed, true, 'Early child exit must finish the startup phase immediately');
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`CLI ${signal} waits for its child and exits successfully`, { skip: process.platform === 'win32' }, async (t) => {
      const source = `
        const { MultiMinerApp, runCli } = require(${JSON.stringify(path.resolve(__dirname, '../mm'))});
        const { formatCommand } = require(${JSON.stringify(path.resolve(__dirname, '../src/command'))});
        const originalStop = MultiMinerApp.prototype.stop;
        MultiMinerApp.prototype.run = async function () {
          process.once('disconnect', () => this.stop().then(() => process.exit(0)));
          process.channel.unref();
          this.logger = { log() {}, err() {}, miner() {} };
          this.minerProc = this.startMinerProcess(formatCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)']), () => {});
          this.minerProc.once('spawn', () => process.stdout.write('CHILD:' + this.minerProc.pid + '\\nREADY\\n'));
        };
        MultiMinerApp.prototype.stop = async function () {
          await originalStop.call(this);
          process.stdout.write('CLOSED\\n');
        };
        runCli(process.argv).catch(() => { process.exitCode = 1; });
      `;
      const proc = childProcess.spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let output = '';
      proc.stdout.on('data', (chunk) => { output += chunk; });
      const closed = once(proc, 'close');
      t.after(async () => {
        // The owned IPC channel asks the fixture to drain its child; never signal a stale PID.
        if (proc.connected) proc.disconnect();
        try {
          await timeout(closed);
        } finally {
          proc.stdout.destroy();
          proc.stderr.destroy();
        }
      });
      await timeout(new Promise((resolve) => {
        proc.stdout.on('data', () => { if (output.includes('READY\n')) resolve(); });
      }));
      proc.kill(signal);
      const [code, exitSignal] = await timeout(closed);
      assert.equal(code, 0);
      assert.equal(exitSignal, null);
      assert.equal(output.includes('CLOSED\n'), true, 'CLI signal must await stop()');
    });
  }

  it('waits for child output closure even when the parent already exited', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-exited-child-'));
    const app = new MultiMinerApp([], { cwd: dir });
    app.logger = startupLogger();
    const source = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 350)'], { stdio: 'inherit' }); process.exit(0);`;
    const proc = app.startMinerProcess(formatCommand(process.execPath, ['-e', source]), () => {});
    let closed = false;
    const closing = once(proc, 'close').then(() => { closed = true; });
    t.after(async () => {
      await timeout(closing);
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await once(proc, 'exit');
    assert.equal(closed, false, 'Fixture must retain a descendant-owned output pipe');
    await timeout(app.stop());
    assert.equal(closed, true, 'Stop must wait for output closure after process exit');
  });
  for (const phase of ['check', 'benchmark']) {
    it(`${phase} waits for descendant-owned pipes before advancing the startup queue`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-startup-drain-'));
      const app = new MultiMinerApp([], { cwd: dir, checkTimeoutMs: 10, benchmarkTimeoutMs: 10 });
      app.logger = startupLogger();
      app.config.algos = { 'cn/gpu': 'fixture-first', etchash: 'fixture-next' };
      let started = 0;
      let first;
      app.startMinerProcess = () => {
        const proc = new EventEmitter();
        proc.exitCode = 0;
        proc.signalCode = null;
        started++;
        if (started === 1) first = proc;
        else queueMicrotask(() => proc.emit('close', 0));
        return proc;
      };
      const running = phase === 'check'
        ? app.checkMiners({ miners: app.config.algos, smartMiners: [] })
        : app.runBenchmarks();
      t.after(async () => {
        first.emit('close', 0);
        await timeout(running);
        await app.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const startedBeforeDrain = started;
      first.emit('close', 0);
      await timeout(running);
      assert.equal(startedBeforeDrain, 1, 'startup must not overlap a draining child');
      assert.equal(started, 2);
    });
  }

});
