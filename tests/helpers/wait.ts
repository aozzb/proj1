/** Poll `fn` until it returns a truthy value, or throw after `timeout` ms. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false | ''>,
  opts: { timeout?: number; interval?: number; label?: string } = {}
): Promise<T> {
  const { timeout = 10000, interval = 50, label = 'condition' } = opts;
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    last = v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeout}ms; last=${String(last)}`);
}
