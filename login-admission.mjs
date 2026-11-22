export function createLoginAdmission({ concurrency, queueLimit }) {
  const queue = [];
  let active = 0;

  async function run(task) {
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  }

  return function admit(task) {
    if (active < concurrency) return run(task);
    if (queue.length >= queueLimit) return null;
    return new Promise((resolve) => {
      queue.push(() => resolve(run(task)));
    });
  };
}
