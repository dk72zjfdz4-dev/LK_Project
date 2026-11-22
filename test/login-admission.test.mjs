import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoginAdmission } from '../login-admission.mjs';

test('login admission runs a bounded FIFO queue and releases its slot after a rejected task', async () => {
  const admit = createLoginAdmission({ concurrency: 1, queueLimit: 2 });
  const active = Promise.withResolvers();
  const next = Promise.withResolvers();
  const started = [];
  const running = admit(() => {
    started.push('first');
    return active.promise;
  });
  const firstQueued = admit(() => {
    started.push('second');
    return next.promise;
  });
  const secondQueued = admit(() => {
    started.push('third');
    return 'third';
  });

  assert.equal(admit(() => assert.fail('A full queue must decline the task')), null);
  assert.deepEqual(started, ['first']);

  active.reject(new Error('Password check failed'));
  await assert.rejects(running, /Password check failed/);
  assert.deepEqual(started, ['first', 'second']);

  next.resolve('second');
  assert.equal(await firstQueued, 'second');
  assert.equal(await secondQueued, 'third');
  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.equal(await admit(() => 'later'), 'later');
});
