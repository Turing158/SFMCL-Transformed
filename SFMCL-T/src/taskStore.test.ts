import { expect, it, vi } from "vitest";
import { createTaskStore } from "./taskStore";
import type { Tasks } from "./types";

it("suppresses unchanged polls and preserves unrelated records", () => {
  const store = createTaskStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  const next = {
    downloads: [
      { id: "one", downloaded: 1 },
      { id: "two", downloaded: 2 },
    ],
    jobs: [{ id: "launch", log: [] }],
  } as unknown as Tasks;
  store.update(next);
  const initial = store.getSnapshot();
  store.update(structuredClone(next));
  expect(store.getSnapshot()).toBe(initial);
  expect(listener).toHaveBeenCalledTimes(1);
  const progress = structuredClone(next);
  progress.downloads[0].downloaded++;
  store.update(progress);
  expect(store.getSnapshot().jobs).toBe(initial.jobs);
  expect(store.getSnapshot().downloads[1]).toBe(initial.downloads[1]);
  expect(listener).toHaveBeenCalledTimes(2);
  store.update({ downloads: [], jobs: initial.jobs });
  expect(store.getSnapshot().downloads).toEqual([]);
  unsubscribe();
  store.update(next);
  expect(listener).toHaveBeenCalledTimes(3);
});
