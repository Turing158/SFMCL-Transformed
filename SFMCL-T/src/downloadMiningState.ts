import type { Download } from "./types";

export type MiningState =
  "idle" | "running" | "paused" | "queued" | "failed" | "cancelled" | "done";

export function downloadMiningState(downloads: Download[]) {
  const active = downloads.filter((d) =>
    ["running", "paused", "pausing", "queued"].includes(d.status),
  );
  const running = active.filter((d) => d.status === "running");
  const state: MiningState = running.length
    ? "running"
    : active.some((d) => ["paused", "pausing"].includes(d.status))
      ? "paused"
      : active.length
        ? "queued"
        : downloads.some((d) => d.status === "failed")
          ? "failed"
          : downloads.some((d) => d.status === "cancelled")
            ? "cancelled"
            : downloads.length
              ? "done"
              : "idle";
  // Historical completed downloads must not inflate the current batch's progress.
  const total = active.reduce((sum, d) => sum + d.total, 0);
  const progress = active.length
    ? active.some((d) => d.unknownSize || d.total <= 0)
      ? null
      : active.reduce(
          (sum, d) => sum + Math.max(0, Math.min(d.downloaded, d.total)),
          0,
        ) / total
    : state === "done"
      ? 1
      : 0;
  const label = {
    idle: "待下载",
    running: "下载中",
    paused: "已暂停",
    queued: "等待下载",
    failed: "需要处理",
    cancelled: "已取消",
    done: "下载完成",
  }[state];
  const detail = active.length
    ? `${progress === null ? "大小未知" : `${Math.round(progress * 100)}%`} · ${active.length} 个任务`
    : state === "done"
      ? "资源已就绪"
      : state === "failed"
        ? "请检查失败任务"
        : state === "cancelled"
          ? "等待下一次下载"
          : "等待下一次冒险";
  return { state, progress, label, detail };
}
