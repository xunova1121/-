/**
 * GET /api/local/metrics 的数据来源（需求 7.2）：CPU 负载、内存占用、网络状态、时间。
 * CPU 用两次采样之间 os.cpus() 时间片的差值计算；网络吞吐读 /proc/net/dev（仅 Linux，其它平台为 null）。
 */
import os from 'node:os';
import fs from 'node:fs/promises';

let lastCpu = snapshotCpu();
let lastNet = null;

function snapshotCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

async function readNet() {
  try {
    const txt = await fs.readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of txt.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    return { rx, tx, t: Date.now() };
  } catch {
    return null;
  }
}

export async function collectMetrics(extra = {}) {
  const cpuNow = snapshotCpu();
  const dTotal = cpuNow.total - lastCpu.total;
  const dIdle = cpuNow.idle - lastCpu.idle;
  lastCpu = cpuNow;
  const cpuPercent = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : null;

  const total = os.totalmem();
  const free = os.freemem();

  const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal);
  const net = await readNet();
  let rxKBps = null;
  let txKBps = null;
  if (net && lastNet && net.t > lastNet.t) {
    const s = (net.t - lastNet.t) / 1000;
    rxKBps = Math.max(0, (net.rx - lastNet.rx) / 1024 / s);
    txKBps = Math.max(0, (net.tx - lastNet.tx) / 1024 / s);
  }
  if (net) lastNet = net;

  return {
    time: new Date().toISOString(),
    cpu: { percent: cpuPercent == null ? null : round(cpuPercent), cores: os.cpus().length, load1: round(os.loadavg()[0]) },
    memory: { percent: round(((total - free) / total) * 100), usedMB: Math.round((total - free) / 2 ** 20), totalMB: Math.round(total / 2 ** 20) },
    network: { online: ifaces.length > 0, interfaces: ifaces.length, rxKBps: rxKBps == null ? null : round(rxKBps), txKBps: txKBps == null ? null : round(txKBps) },
    uptimeSec: Math.round(os.uptime()),
    ...extra
  };
}

const round = (x) => Math.round(x * 10) / 10;
