import { describe, expect, it } from "vitest";
import { getLaunchTask, isActiveLaunch } from "./launchState";
import type { Download, Job, Tasks } from "./types";

function launch(overrides: Partial<Job> = {}): Job {
  return {
    id: "launch-1",
    title: "启动 1.21.4",
    status: "running",
    currentStep: 0,
    steps: [
      "检查游戏与 Java",
      "检查资源索引",
      "补全游戏文件",
      "准备运行环境",
      "游戏运行",
    ].map((name, index) => ({
      name,
      status: index === 0 ? "running" : "queued",
      detail: "",
    })),
    log: [],
    ...overrides,
  };
}

function download(overrides: Partial<Download> = {}): Download {
  return {
    id: "assets",
    title: "1.21.4 · 启动检查",
    status: "running",
    downloaded: 50,
    total: 100,
    unknownSize: false,
    completed: 5,
    failed: 0,
    fileCount: 10,
    speed: 1,
    workers: 1,
    steps: [],
    ...overrides,
  };
}

const tasks = (job: Job, files?: Download): Tasks => ({
  jobs: [job],
  downloads: files ? [files] : [],
});

describe("launch task state", () => {
  it("ignores installation jobs and unrelated completed launches", () => {
    const result = getLaunchTask(
      {
        downloads: [],
        jobs: [
          launch({ title: "安装 1.21.4" }),
          launch({ title: "启动 another", status: "completed" }),
        ],
      },
      "1.21.4",
    );
    expect(result).toMatchObject({
      phase: "idle",
      active: false,
      detail: "准备就绪",
    });
    expect(result.job).toBeUndefined();
  });

  it("keeps a live instance visible after the selected version changes", () => {
    const job = launch({ currentStep: 4 });
    expect(getLaunchTask(tasks(job), "1.20.1")).toMatchObject({
      phase: "running",
      active: true,
      versionId: "1.21.4",
      job,
    });
  });

  it.each(["queued", "running", "pausing", "paused"] as const)(
    "keeps %s launches locked",
    (status) => {
      expect(isActiveLaunch(launch({ status }), [])).toBe(true);
    },
  );

  it("does not confuse resource preparation with a running game", () => {
    expect(
      getLaunchTask(tasks(launch({ currentStep: 3 })), "1.21.4"),
    ).toMatchObject({ phase: "preparing", stepLabel: "第 4 / 4 步" });
  });

  it("resumes failed downloads on the same still-live launch", () => {
    const job = launch({
      status: "failed",
      currentStep: 2,
      downloadId: "assets",
    });
    const files = download({ status: "failed", error: "连接中断" });
    expect(getLaunchTask(tasks(job, files), "1.21.4")).toMatchObject({
      phase: "download-error",
      active: true,
      detail: "连接中断",
      download: files,
    });
  });

  it.each(["paused", "pausing"] as const)(
    "offers continuation for %s downloads",
    (status) => {
      const result = getLaunchTask(
        tasks(
          launch({ status, downloadId: "assets", currentStep: 2 }),
          download({ status }),
        ),
        "1.21.4",
      );
      expect(result.phase).toBe("paused");
      expect(result.active).toBe(true);
    },
  );

  it("releases failed workflows whose file batch was cancelled", () => {
    const result = getLaunchTask(
      tasks(
        launch({ status: "failed", downloadId: "assets", error: "下载已取消" }),
        download({ status: "cancelled" }),
      ),
      "1.21.4",
    );
    expect(result).toMatchObject({
      phase: "failed",
      active: false,
      detail: "下载已取消",
    });
  });

  it("keeps preflight failures available for retry", () => {
    expect(
      getLaunchTask(
        tasks(launch({ status: "failed", error: "未找到 Java 21" })),
        "1.21.4",
      ),
    ).toMatchObject({
      phase: "failed",
      active: false,
      detail: "未找到 Java 21",
    });
  });

  it("uses the most recent attempt instead of an older error", () => {
    const latest = launch({
      id: "latest",
      status: "completed",
      currentStep: 4,
    });
    const result = getLaunchTask(
      {
        jobs: [latest, launch({ status: "failed", error: "old failure" })],
        downloads: [],
      },
      "1.21.4",
    );
    expect(result.job?.id).toBe("latest");
    expect(result.phase).toBe("idle");
  });

  it.each(["completed", "cancelled"] as const)(
    "restores start after a game is %s",
    (status) => {
      expect(
        getLaunchTask(tasks(launch({ status, currentStep: 4 })), "1.21.4"),
      ).toMatchObject({
        phase: "idle",
        active: false,
        detail: "游戏已结束，随时可以再次出发",
      });
    },
  );

  it("explains a cancellation during preparation", () => {
    expect(
      getLaunchTask(
        tasks(launch({ status: "cancelled", currentStep: 1 })),
        "1.21.4",
      ).detail,
    ).toBe("启动已取消，可以重新出发");
  });

  it("calculates progress from completed setup steps and real download bytes", () => {
    const job = launch({ currentStep: 2, downloadId: "assets" });
    job.steps[0].status = job.steps[1].status = "completed";
    const result = getLaunchTask(tasks(job, download()), "1.21.4");
    expect(result.progress).toBe(62.5);
    expect(result.stepLabel).toBe("第 3 / 4 步");
    expect(result.detail).toContain("5 / 10 个文件");
  });

  it("uses file counts for unknown sizes and clamps transient counter overshoot", () => {
    const job = launch({ currentStep: 2, downloadId: "assets" });
    job.steps[0].status = job.steps[1].status = "completed";
    expect(
      getLaunchTask(
        tasks(
          job,
          download({ unknownSize: true, downloaded: 999, completed: 2 }),
        ),
        "1.21.4",
      ).progress,
    ).toBeCloseTo(55);
    expect(
      getLaunchTask(tasks(job, download({ downloaded: 999 })), "1.21.4")
        .progress,
    ).toBe(75);
  });

  it("leaves progress indeterminate before step metadata is available", () => {
    expect(
      getLaunchTask(tasks(launch({ steps: [] })), "1.21.4").progress,
    ).toBeUndefined();
  });
});
