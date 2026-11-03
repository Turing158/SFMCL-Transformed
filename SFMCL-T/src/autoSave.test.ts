import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoSave,
  flushAutoSaves,
  mergePending,
  registerAutoSave,
} from "./autoSave";
import { prepareGameSettings } from "./gameSettings";
import type { GameSettings } from "./types";

afterEach(() => vi.useRealTimers());

const setup = <T extends object>(
  initial: T,
  persist = vi.fn(async (_previous: T, next: T) => next),
) => {
  const failed = vi.fn();
  const queue = new AutoSave(
    initial,
    persist,
    (value) => value,
    vi.fn(),
    failed,
  );
  return { queue, persist, failed };
};

describe("automatic settings persistence", () => {
  it("does not write when opened, refreshed or changed to the same value", async () => {
    vi.useFakeTimers();
    const { queue, persist } = setup({ title: "Saved" });
    queue.receive({ title: "Saved" });
    queue.update((value) => ({ ...value }));
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
  });

  it("coalesces rapid edits and flushes immediately when leaving", async () => {
    vi.useFakeTimers();
    const { queue, persist } = setup({ title: "", width: 1280 });
    queue.update((value) => ({ ...value, title: "A" }));
    queue.update((value) => ({ ...value, title: "AB", width: 1600 }));
    expect(queue.pending).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    await queue.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(queue.saved).toEqual({ title: "AB", width: 1600 });
    expect(queue.pending).toBe(false);
  });

  it("serializes writes and never restores an older response over newer input", async () => {
    let complete!: (value: { title: string; width: number }) => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockImplementation(async (_previous, next) => next);
    const { queue } = setup({ title: "", width: 1280 }, persist);
    queue.update((value) => ({ ...value, title: "First" }));
    const saving = queue.flush();
    queue.update((value) => ({ ...value, title: "Latest", width: 1920 }));
    expect(persist).toHaveBeenCalledTimes(1);
    complete({ title: "First", width: 1280 });
    await saving;
    expect(persist).toHaveBeenCalledTimes(2);
    expect(queue.value).toEqual({ title: "Latest", width: 1920 });
    expect(queue.saved).toEqual(queue.value);
  });

  it("preserves nested pending edits when Java lists and scope flags change externally", () => {
    const saved = {
      settings: { javaPaths: ["old"], title: "" },
      groups: { java: false, memory: false },
    };
    const pending = {
      settings: { javaPaths: ["old"], title: "Latest" },
      groups: { java: false, memory: true },
    };
    const next = {
      settings: { javaPaths: ["new"], title: "" },
      groups: { java: true, memory: false },
    };
    expect(mergePending(pending, saved, next)).toEqual({
      settings: { javaPaths: ["new"], title: "Latest" },
      groups: { java: true, memory: true },
    });
  });

  it("waits for all final edits of an unmounted page before reopening or launching", async () => {
    let complete!: (value: { title: string }) => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockImplementation(async (_previous, next) => next);
    const { queue } = setup({ title: "" }, persist);
    const unregister = registerAutoSave(queue);
    queue.update((value) => ({ ...value, title: "First" }));
    void queue.flush();
    queue.update((value) => ({ ...value, title: "Final" }));
    unregister();
    const reopening = flushAutoSaves();
    complete({ title: "First" });
    expect(await reopening).toBe(true);
    expect(queue.saved?.title).toBe("Final");
  });

  it("keeps the live registration when Strict Mode repeats effect setup", async () => {
    const { queue } = setup({ title: "" });
    const firstCleanup = registerAutoSave(queue);
    firstCleanup();
    const finalCleanup = registerAutoSave(queue);
    await Promise.resolve();
    await Promise.resolve();
    queue.update((value) => ({ ...value, title: "Retained registration" }));
    expect(await flushAutoSaves()).toBe(true);
    expect(queue.saved?.title).toBe("Retained registration");
    finalCleanup();
  });

  it("keeps incomplete numeric input local without blocking other valid settings", async () => {
    const initial = {
      memoryMb: 4096,
      width: 1280,
      height: 720,
      windowTitle: "",
    } as GameSettings;
    const persist = vi.fn(async (_previous, next) => next);
    const queue = new AutoSave(
      initial,
      persist,
      prepareGameSettings,
      vi.fn(),
      vi.fn(),
    );
    queue.update((value) => ({
      ...value,
      width: 0,
      windowTitle: "Valid title",
    }));
    await queue.flush();
    expect(queue.saved).toMatchObject({
      width: 1280,
      windowTitle: "Valid title",
    });
    expect(queue.value?.width).toBe(0);
    expect(queue.pending).toBe(false);
    queue.update((value) => ({ ...value, width: 1600 }));
    await queue.flush();
    expect(queue.saved?.width).toBe(1600);
  });

  it("retains edits and retries temporary write failures without manual saving", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disk unavailable"))
      .mockImplementation(async (_previous, next) => next);
    const { queue, failed } = setup({ title: "" }, persist);
    queue.update((value) => ({ ...value, title: "Keep me" }));
    await queue.flush();
    expect(queue.value?.title).toBe("Keep me");
    expect(queue.saved?.title).toBe("");
    expect(failed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.saved?.title).toBe("Keep me");
    expect(queue.pending).toBe(false);
  });
});
