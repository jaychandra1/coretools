/** Decrypting this many records at a time keeps a large vault's unlock fast. */
export const BATCH_SIZE = 64;

/** Map with a bounded number of concurrent async calls; results in order. */
export async function inBatches<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  size = BATCH_SIZE,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}
