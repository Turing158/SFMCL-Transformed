function imageKey(path: string) {
  // Windows paths from Rust and file pickers can differ in case/separators.
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path)
    ? path.replaceAll("\\", "/").toLowerCase()
    : path;
}

export function createImageCache(
  maxEntries = 100,
  maxBytes = 24 * 1024 * 1024,
) {
  const values = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  let bytes = 0;
  let revision = 0;
  const remove = (key: string) => {
    const value = values.get(key);
    if (value !== undefined) bytes -= value.length * 2;
    values.delete(key);
  };
  return {
    revision: (path: string) => versions.get(imageKey(path)) ?? 0,
    subscribe(path: string, listener: () => void) {
      const key = imageKey(path);
      const subscribers = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, subscribers);
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          listeners.delete(key);
          versions.delete(key);
        }
      };
    },
    invalidate(paths: Iterable<string>) {
      for (const key of new Set(Array.from(paths, imageKey))) {
        if (!key) continue;
        remove(key);
        // Old requests can finish, but cannot repopulate the cache.
        pending.delete(key);
        const subscribers = listeners.get(key);
        if (subscribers) {
          versions.set(key, ++revision);
          subscribers.forEach((listener) => listener());
        }
      }
    },
    load(path: string, fetch: () => Promise<string>): Promise<string> {
      const key = imageKey(path);
      const cached = values.get(key);
      if (cached !== undefined) {
        values.delete(key);
        values.set(key, cached);
        return Promise.resolve(cached);
      }
      const existing = pending.get(key);
      if (existing) return existing;
      const request = Promise.resolve()
        .then(fetch)
        .then((value) => {
          if (pending.get(key) !== request) return value;
          const size = value.length * 2;
          if (size <= maxBytes) {
            remove(key);
            values.set(key, value);
            bytes += size;
            while (values.size > maxEntries || bytes > maxBytes) {
              remove(values.keys().next().value!);
            }
          }
          return value;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
  };
}

const images = createImageCache();
export const imageRevision = images.revision;
export const subscribeImages = images.subscribe;
export const invalidateImages = images.invalidate;
export const loadImage = images.load;
