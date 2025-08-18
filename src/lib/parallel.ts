export const runParallelStride = async <T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  const total = items.length;
  if (total === 0) {
    return;
  }
  const workerCount = Math.max(1, Math.min(concurrency, total));
  const workers: Promise<void>[] = [];
  for (let startIndex = 0; startIndex < workerCount; startIndex += 1) {
    workers.push(
      (async (start: number) => {
        for (let idx = start; idx < total; idx += workerCount) {
          // eslint-disable-next-line no-await-in-loop
          await run(items[idx]!, idx);
        }
      })(startIndex),
    );
  }
  await Promise.all(workers);
};
