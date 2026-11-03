const queues = new Map<
  { flush: () => Promise<void>; pending: boolean },
  symbol
>();

export function registerAutoSave(queue: {
  flush: () => Promise<void>;
  pending: boolean;
}) {
  const registration = Symbol();
  queues.set(queue, registration);
  return () => {
    // Keep an unmounted page registered until its final writes finish, so
    // reopening the same version cannot read an intermediate configuration.
    void queue.flush().finally(() => {
      if (queues.get(queue) === registration) queues.delete(queue);
    });
  };
}

export async function flushAutoSaves() {
  const pending = [...queues.keys()];
  await Promise.all(pending.map((queue) => queue.flush()));
  return pending.every((queue) => !queue.pending);
}

export function changedValues<T extends object>(
  previous: T,
  next: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(value) !== JSON.stringify(previous[key as keyof T]),
    ),
  ) as Partial<T>;
}

// Merge untouched fields from a saved response without replacing newer edits.
// Version settings contain nested game settings and independent-group flags.
export function mergePending<T>(current: T, previous: T, next: T): T {
  if (JSON.stringify(current) === JSON.stringify(previous)) return next;
  if (
    current &&
    previous &&
    next &&
    typeof current === "object" &&
    typeof previous === "object" &&
    typeof next === "object" &&
    !Array.isArray(current) &&
    !Array.isArray(previous) &&
    !Array.isArray(next)
  ) {
    const result = { ...next };
    for (const key of Object.keys(current) as (keyof T)[])
      result[key] = mergePending(current[key], previous[key], next[key]);
    return result;
  }
  return current;
}

export class AutoSave<T extends object> {
  value: T | null;
  saved: T | null;
  saving = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private retries = 0;

  constructor(
    initial: T | null,
    private persist: (previous: T, next: T) => Promise<T>,
    private prepare: (value: T, saved: T) => T,
    private changed: () => void,
    private failed: (error: unknown) => void,
  ) {
    this.value = this.saved = initial;
  }

  get pending() {
    return (
      this.saving ||
      !!(
        this.value &&
        this.saved &&
        Object.keys(
          changedValues(this.saved, this.prepare(this.value, this.saved)),
        ).length
      )
    );
  }

  receive(next: T | null) {
    this.value =
      this.value && this.saved && next
        ? mergePending(this.value, this.saved, next)
        : next;
    this.saved = next;
    this.changed();
  }

  sync(update: (value: T) => T) {
    if (this.value) this.value = update(this.value);
    if (this.saved) this.saved = update(this.saved);
    this.changed();
  }

  update(update: (value: T) => T) {
    if (!this.value) return;
    this.value = update(this.value);
    this.retries = 0;
    this.changed();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    const work = this.write();
    this.running = work;
    void work.finally(() => {
      if (this.running === work) this.running = undefined;
    });
    return work;
  }

  private async write() {
    while (this.value && this.saved) {
      const previous = this.saved;
      const next = this.prepare(this.value, previous);
      if (!Object.keys(changedValues(previous, next)).length) break;
      this.saving = true;
      this.changed();
      try {
        const saved = await this.persist(previous, next);
        this.value = mergePending(this.value, next, saved);
        this.saved = saved;
        this.retries = 0;
      } catch (error) {
        if (this.retries === 0) this.failed(error);
        if (this.retries < 3) {
          this.timer = setTimeout(
            () => void this.flush(),
            1000 * 2 ** this.retries,
          );
          this.retries += 1;
        }
        break;
      }
    }
    this.saving = false;
    this.changed();
  }
}
