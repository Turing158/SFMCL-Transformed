import type { Tasks } from "./types";

function reconcile<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const items = next.map((item) => {
    const old = byId.get(item.id);
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
  });
  return items.length === previous.length &&
    items.every((item, i) => item === previous[i])
    ? previous
    : items;
}

export function createTaskStore() {
  let snapshot: Tasks = { downloads: [], jobs: [] };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: Tasks) {
      const downloads = reconcile(snapshot.downloads, next.downloads);
      const jobs = reconcile(snapshot.jobs, next.jobs);
      if (downloads === snapshot.downloads && jobs === snapshot.jobs) return;
      snapshot = { downloads, jobs };
      listeners.forEach((listener) => listener());
    },
  };
}
