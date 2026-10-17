import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountContextLock } from '../src/core/contextLock.js';

test('run lease is exclusive even for the same owner', () => {
  const lock = new AccountContextLock();
  const first = lock.tryAcquireExclusive('task-run');
  assert.equal(first.acquired, true);
  assert.equal(first.ticket, 1);

  const second = lock.tryAcquireExclusive('task-run');
  assert.equal(second.acquired, false);
  assert.equal(second.owner, 'task-run');

  assert.equal(lock.releaseExclusive('task-run', first.ticket), true);
  assert.equal(lock.isBusy(), false);
});

test('stale run lease cannot release a newer run', () => {
  const lock = new AccountContextLock();
  const first = lock.tryAcquireExclusive('task-run');
  lock.forceRelease('test');
  const second = lock.tryAcquireExclusive('task-run');
  assert.equal(second.acquired, true);

  assert.equal(lock.releaseExclusive('task-run', first.ticket), false);
  assert.equal(lock.isBusy(), true);
  assert.equal(lock.snapshot().ticket, second.ticket);
  assert.equal(lock.releaseExclusive('task-run', second.ticket), true);
});
