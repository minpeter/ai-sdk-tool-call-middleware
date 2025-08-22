export type Task<T> = () => Promise<T>;

export type RunOptions = { concurrency?: number; failFast?: boolean };

export async function runWithConcurrency<T>(
  tasks: Task<T>[],
  options: RunOptions = {}
): Promise<T[]> {
  const concurrency = options.concurrency ?? 4;
  const failFast = options.failFast ?? false;

  if (tasks.length === 0) return [];
  const results: T[] = [];
  let index = 0;

  let rejectEarly: ((err: unknown) => void) | null = null;
  const earlyRejectPromise = new Promise<never>((_res, rej) => {
    rejectEarly = rej;
  });

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        const r = await tasks[i]();
        results[i] = r;
      } catch (err) {
        if (failFast && rejectEarly) rejectEarly(err);
        else throw err;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );

  if (failFast) {
    // race between workers completing and an early rejection
    await Promise.race([Promise.all(workers), earlyRejectPromise]);
  } else {
    await Promise.all(workers);
  }

  return results;
}

export type SettledResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export async function runWithConcurrencySettled<T>(
  tasks: Task<T>[],
  options: RunOptions = {}
): Promise<SettledResult<T>[]> {
  const concurrency = options.concurrency ?? 4;
  if (tasks.length === 0) return [];
  const results: SettledResult<T>[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try {
        const v = await tasks[i]();
        results[i] = { status: "fulfilled", value: v };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
