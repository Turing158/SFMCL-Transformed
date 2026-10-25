import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelConfirmations,
  confirmAction,
  currentConfirmation,
  finishConfirmation,
  subscribeConfirmations,
} from "./confirmation";

describe("confirmation decisions", () => {
  let unsubscribe: () => void;
  beforeEach(() => {
    unsubscribe = subscribeConfirmations(() => {});
  });
  afterEach(() => {
    unsubscribe();
    cancelConfirmations();
  });

  it("waits for a decision and keeps concurrent requests separate", async () => {
    const execute = vi.fn();
    const first = confirmAction("删除版本？").then((accepted) => {
      if (accepted) execute();
      return accepted;
    });
    const firstId = currentConfirmation()!.id;
    const second = confirmAction("移除角色？");
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(currentConfirmation()!.message).toBe("删除版本？");
    finishConfirmation(firstId, false);
    await expect(first).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
    const secondId = currentConfirmation()!.id;
    finishConfirmation(firstId, true);
    expect(currentConfirmation()!.id).toBe(secondId);
    finishConfirmation(secondId, true);
    await expect(second).resolves.toBe(true);
    expect(currentConfirmation()).toBeNull();
  });

  it("resolves an accepted action only once", async () => {
    const execute = vi.fn();
    const pending = confirmAction("删除材质包？").then((accepted) => {
      if (accepted) execute();
    });
    const id = currentConfirmation()!.id;
    finishConfirmation(id, true);
    finishConfirmation(id, true);
    finishConfirmation(id, false);
    await pending;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("cancels every waiting action when the dialog host goes away", async () => {
    const first = confirmAction("删除版本？");
    const id = currentConfirmation()!.id;
    const second = confirmAction("移除角色？");
    cancelConfirmations();
    finishConfirmation(id, true);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(currentConfirmation()).toBeNull();
  });

  it("cancels immediately if no dialog host is available", async () => {
    unsubscribe();
    await expect(confirmAction("删除版本？")).resolves.toBe(false);
    expect(currentConfirmation()).toBeNull();
  });
});
