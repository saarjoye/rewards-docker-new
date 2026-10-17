/**
 * 账号上下文锁
 *
 * 账号上下文（networkClient.activeCookie / rewardsApi.currentAccountId / logger 账号前缀）
 * 是全局可变状态，因此所有会切换账号的流程必须串行。
 *
 * 普通锁按 owner 可重入；任务执行入口则使用带票据的独占租约，确保即使两个请求
 * 同时到达，也只有一个 runAll 能启动。
 */
export class AccountContextLock {
  constructor() {
    this.owner = null;
    this.depth = 0;
    this.acquiredAt = 0;
    this.lastOwner = null;
    this.lastReleasedAt = 0;
    this.ticket = 0;
  }

  /**
   * 是否被占用。持有超时后自动释放，作为异常残留的防御性兜底。
   */
  isBusy() {
    if (this.owner) {
      const heldMs = Date.now() - this.acquiredAt;
      const limitMs = this.owner === 'task-run' ? 4 * 60 * 60 * 1000 : 10 * 60 * 1000;
      if (heldMs > limitMs) {
        this.forceRelease(`stale-${this.owner}-${Math.round(heldMs / 1000)}s`);
        return false;
      }
    }
    return this.owner !== null;
  }

  currentOwner() {
    return this.owner;
  }

  snapshot() {
    return {
      owner: this.owner,
      depth: this.depth,
      heldMs: this.owner ? Date.now() - this.acquiredAt : 0,
      lastOwner: this.lastOwner,
      lastReleasedAt: this.lastReleasedAt,
      ticket: this.ticket
    };
  }

  /**
   * 非阻塞获取。同一 owner 重复获取是重入。
   */
  tryAcquire(owner) {
    if (this.owner !== null && this.owner !== owner) return false;
    if (this.owner === null) this.acquiredAt = Date.now();
    this.owner = owner;
    this.depth += 1;
    return true;
  }

  async acquire(owner, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.tryAcquire(owner)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  release(owner) {
    if (this.owner !== owner) {
      this.lastMismatch = { expected: this.owner, got: owner, at: Date.now() };
      return false;
    }
    this.depth -= 1;
    if (this.depth <= 0) {
      this.depth = 0;
      this.owner = null;
      this.acquiredAt = 0;
      this.lastOwner = owner;
      this.lastReleasedAt = Date.now();
    }
    return true;
  }

  /**
   * 独占租约（不可重入），用于任务执行入口。
   * 票据确保旧执行流不能释放后来者的锁。
   */
  tryAcquireExclusive(owner) {
    if (this.owner !== null) {
      return { acquired: false, owner: this.owner, ticket: this.ticket };
    }
    this.owner = owner;
    this.depth = 1;
    this.acquiredAt = Date.now();
    this.ticket += 1;
    return { acquired: true, owner, ticket: this.ticket };
  }

  releaseExclusive(owner, ticket) {
    if (this.owner !== owner || this.ticket !== ticket || this.depth !== 1) {
      this.lastMismatch = {
        expected: this.owner,
        got: owner,
        expectedTicket: this.ticket,
        gotTicket: ticket,
        at: Date.now()
      };
      return false;
    }
    this.depth = 0;
    this.owner = null;
    this.acquiredAt = 0;
    this.lastOwner = owner;
    this.lastReleasedAt = Date.now();
    return true;
  }

  forceRelease(reason = 'manual') {
    const prev = {
      owner: this.owner,
      depth: this.depth,
      heldMs: this.acquiredAt ? Date.now() - this.acquiredAt : 0
    };
    this.owner = null;
    this.depth = 0;
    this.acquiredAt = 0;
    this.ticket += 1;
    this.lastForceRelease = { ...prev, reason, at: Date.now() };
    return prev;
  }
}

/** 浏览器资源锁与账号上下文锁彼此独立。 */
export const accountContextLock = new AccountContextLock();
export const browserSlotLock = new AccountContextLock();
export default accountContextLock;
