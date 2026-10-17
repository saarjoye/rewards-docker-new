/**
 * 容器内存/进程采样器（守护进程内独立运行，不依赖是否有人打开 WebUI）。
 *
 * 为什么需要它：docker stats 是人肉命令，用户不可能一直盯着。
 * 而「峰值到底多少」正是决定要不要设 mem_limit、设多少的依据。
 * 这里每 15 秒采一次，把「本次进程生命周期内的最高水位」持久化到
 * data/memory_samples.json，重启容器也不丢上一次的峰值。
 *
 * 采样内容刻意区分两类内存：
 *   - anon  匿名内存：进程堆/栈，**无 swap 时内核不能回收**，是真实占用；
 *   - file  页缓存：可被内核回收，docker stats 会扣除 inactive 部分。
 * 只有 anon 高才是「真占内存」，file 高只是缓存。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const SAMPLE_FILE = path.join(DATA_DIR, 'memory_samples.json');
const SAMPLE_INTERVAL_MS = 15 * 1000;
// 峰值历史只保留最近 30 次「任务级」记录，避免文件无限增长
const MAX_HISTORY = 30;

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function statValue(statText, key) {
  if (!statText) return 0;
  const m = String(statText).match(new RegExp('^' + key + '\\s+(\\d+)', 'm'));
  return m ? Number(m[1]) : 0;
}

/**
 * 解析当前进程所在的 cgroup 目录（v2 优先）。
 * 逻辑与 web/server.js 保持一致，但这里只关心 memory。
 */
function resolveMemoryDirs() {
  const dirs = [];
  const selfCgroup = readText('/proc/self/cgroup') || '';
  const selfV2 = (selfCgroup.match(/^0::(.+)$/m) || [])[1];
  const mountInfo = readText('/proc/self/mountinfo') || '';

  for (const line of mountInfo.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    // mountinfo 格式: id parent major:minor root mountpoint options ... - fstype source superopts
    const dashIdx = parts.indexOf('-');
    if (dashIdx === -1) continue;
    const fstype = parts[dashIdx + 1];
    if (fstype !== 'cgroup2') continue;
    const root = parts[3];
    const mountPoint = parts[4];
    let rel = selfV2 || '/';
    if (root && root !== '/' && rel.startsWith(root)) rel = rel.slice(root.length) || '/';
    dirs.push(path.join(mountPoint, rel));
  }

  // 命名空间私有时 /sys/fs/cgroup 根就是容器自身
  if (selfV2 === '/' || !selfV2) dirs.push('/sys/fs/cgroup');
  return [...new Set(dirs)];
}

/** 采集一次内存明细（字节）。读不到返回 null。 */
export function sampleMemory() {
  for (const dir of resolveMemoryDirs()) {
    const current = readText(path.join(dir, 'memory.current'));
    if (current === null) continue;
    const stat = readText(path.join(dir, 'memory.stat'));
    const limitRaw = readText(path.join(dir, 'memory.max'));
    const limit = limitRaw && limitRaw !== 'max' ? Number(limitRaw) : null;
    return {
      totalBytes: Number(current),
      anonBytes: statValue(stat, 'anon'),
      fileBytes: statValue(stat, 'file'),
      inactiveAnonBytes: statValue(stat, 'inactive_anon'),
      inactiveFileBytes: statValue(stat, 'inactive_file'),
      shmemBytes: statValue(stat, 'shmem'),
      limitBytes: limit && Number.isFinite(limit) ? limit : null,
      source: 'cgroup v2',
      at: Date.now()
    };
  }
  return null;
}

/** 统计容器内僵尸进程数（读不到 /proc 返回 null）。 */
export function sampleZombies() {
  let total = 0;
  let zombies = 0;
  try {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const status = readText(`/proc/${name}/status`);
      if (!status) continue;
      total += 1;
      if (/^State:\s*Z/m.test(status)) zombies += 1;
    }
  } catch {
    return null;
  }
  return { total, zombies };
}

function loadStore() {
  try {
    if (!fs.existsSync(SAMPLE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStore(store) {
  try {
    writeFileAtomic(SAMPLE_FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

const toMiB = (bytes) => (Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null);

/**
 * 内存采样器。start() 后每 15 秒采一次；
 * peak 是「本容器自进程启动以来」的最高水位，并保留跨重启的历史峰值。
 */
export class MemorySampler {
  constructor() {
    this.timer = null;
    this.current = null;
    this.peak = null;
    this.startedAt = 0;
    this.lastZombies = null;
    this.zombiePeak = 0;
    this.store = loadStore() || { version: 1, lastRun: null, history: [] };
  }

  start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    const tick = () => {
      const mem = sampleMemory();
      const zom = sampleZombies();
      if (mem) {
        this.current = mem;
        if (!this.peak || mem.totalBytes > this.peak.totalBytes) {
          this.peak = { ...mem };
        }
      }
      if (zom) {
        this.lastZombies = zom;
        if (zom.zombies > this.zombiePeak) this.zombiePeak = zom.zombies;
      }
    };
    tick();
    this.timer = setInterval(tick, SAMPLE_INTERVAL_MS);
    // 不要让采样器阻止进程退出
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 本进程生命周期的峰值（含 anon/file 拆分）。 */
  getPeak() {
    const p = this.peak;
    return {
      totalMiB: p ? toMiB(p.totalBytes) : null,
      anonMiB: p ? toMiB(p.anonBytes) : null,
      fileMiB: p ? toMiB(p.fileBytes) : null,
      shmemMiB: p ? toMiB(p.shmemBytes) : null,
      at: p ? p.at : null,
      zombiePeak: this.zombiePeak,
      current: this.current ? {
        totalMiB: toMiB(this.current.totalBytes),
        anonMiB: toMiB(this.current.anonBytes),
        fileMiB: toMiB(this.current.fileBytes),
        limitMiB: toMiB(this.current.limitBytes)
      } : null,
      zombies: this.lastZombies
    };
  }

  /**
   * 结束一次「任务级」采样，把结果写入历史文件。
   * 由任务执行结束后调用，便于跨天对比。
   */
  commitRun(label = 'task') {
    const peak = this.getPeak();
    if (peak.totalMiB === null) return null;
    const entry = {
      label: String(label),
      startedAt: this.startedAt,
      endedAt: Date.now(),
      peakMiB: peak.totalMiB,
      peakAnonMiB: peak.anonMiB,
      peakFileMiB: peak.fileMiB,
      zombiePeak: peak.zombiePeak,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      platform: `${os.type()} ${os.arch()}`
    };
    this.store.lastRun = entry;
    this.store.history = [entry, ...(this.store.history || [])].slice(0, MAX_HISTORY);
    saveStore(this.store);
    return entry;
  }

  /** 历史记录（最近的在前）。 */
  getHistory() {
    return {
      lastRun: this.store.lastRun || null,
      history: this.store.history || []
    };
  }
}

export const memorySampler = new MemorySampler();
export default memorySampler;
