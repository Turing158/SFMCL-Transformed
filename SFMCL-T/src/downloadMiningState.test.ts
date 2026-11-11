import { describe, expect, it } from "vitest";
import { downloadMiningState } from "./downloadMiningState";
import type { Download, Status } from "./types";

function download(status: Status, overrides: Partial<Download> = {}): Download {
  return {
    id: status,
    title: status,
    status,
    downloaded: 20,
    total: 100,
    unknownSize: false,
    completed: 0,
    failed: 0,
    fileCount: 1,
    speed: 0,
    workers: 1,
    steps: [],
    ...overrides,
  };
}

describe("download header mining feedback", () => {
  it("distinguishes empty and successful histories from failures and cancellation", () => {
    expect(downloadMiningState([]).state).toBe("idle");
    expect(downloadMiningState([download("completed")]).state).toBe("done");
    for (const status of ["failed", "cancelled"] as const) {
      expect(
        downloadMiningState([download("completed"), download(status)]).state,
      ).toBe(status);
    }
  });

  it("keeps running, queued and paused work ahead of historical results", () => {
    const history = [download("completed"), download("failed")];
    for (const [status, expected] of [
      ["running", "running"],
      ["queued", "queued"],
      ["pausing", "paused"],
      ["paused", "paused"],
    ] as const) {
      expect(downloadMiningState([...history, download(status)]).state).toBe(
        expected,
      );
    }
    expect(
      downloadMiningState([download("paused"), download("running")]).state,
    ).toBe("running");
  });

  it("weights active bytes and excludes completed history", () => {
    const result = downloadMiningState([
      download("completed", { downloaded: 10000, total: 10000 }),
      download("running", { downloaded: 50, total: 100 }),
      download("paused", { downloaded: 30, total: 300 }),
    ]);
    expect(result.progress).toBe(0.2);
    expect(result.detail).toBe("20% · 2 个任务");
  });

  it("does not invent percentages for unknown sizes or complete before the task succeeds", () => {
    expect(
      downloadMiningState([download("running", { unknownSize: true })])
        .progress,
    ).toBeNull();
    expect(
      downloadMiningState([download("queued", { total: 0 })]).progress,
    ).toBeNull();
    expect(
      downloadMiningState([download("running", { downloaded: 100 })]).state,
    ).toBe("running");
    expect(
      downloadMiningState([download("running", { downloaded: 120 })]).progress,
    ).toBe(1);
  });
});
