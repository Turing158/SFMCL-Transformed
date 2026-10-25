import type { Download, Job, Tasks } from "./types";

export type LaunchPhase =
  "idle" | "preparing" | "running" | "paused" | "download-error" | "failed";

export interface LaunchTask {
  job?: Job;
  download?: Download;
  active: boolean;
  phase: LaunchPhase;
  versionId: string;
  detail: string;
  stepLabel: string;
  progress?: number;
}

export function isActiveLaunch(job: Job, downloads: Download[]) {
  if (!job.title.startsWith("启动 ")) return false;
  if (["queued", "running", "pausing", "paused"].includes(job.status)) {
    return true;
  }
  // A failed download remains attached to a live launch workflow and retains
  // its version lock. Resume that download instead of creating another launch.
  return (
    job.status === "failed" &&
    downloads.some(
      (download) =>
        download.id === job.downloadId && download.status === "failed",
    )
  );
}

export function getLaunchTask(
  tasks: Tasks,
  selectedVersion: string,
): LaunchTask {
  // The backend returns newest jobs first. A running instance takes precedence
  // if the user changes the selected version from another page.
  const jobs = tasks.jobs.filter((job) => job.title.startsWith("启动 "));
  const job =
    jobs.find((item) => isActiveLaunch(item, tasks.downloads)) ||
    jobs.find((item) => item.title === `启动 ${selectedVersion}`);
  const download = tasks.downloads.find((item) => item.id === job?.downloadId);
  const active = !!job && isActiveLaunch(job, tasks.downloads);
  const currentStep = job?.steps[job.currentStep];
  const gameStep =
    job?.steps.findIndex((step) => step.name === "游戏运行") ?? -1;
  const setupSteps =
    job?.steps.slice(0, gameStep < 0 ? undefined : gameStep) || [];
  const completed = setupSteps.filter(
    (step) => step.status === "completed",
  ).length;
  const downloadProgress = download
    ? !download.unknownSize && download.total > 0
      ? download.downloaded / download.total
      : download.fileCount > 0
        ? download.completed / download.fileCount
        : 0
    : 0;
  const progress = setupSteps.length
    ? Math.min(
        100,
        ((completed + Math.max(0, Math.min(1, downloadProgress))) /
          setupSteps.length) *
          100,
      )
    : undefined;
  let phase: LaunchPhase = "idle";
  let detail = "准备就绪";

  if (active) {
    if (download?.status === "failed") {
      phase = "download-error";
      detail = download.error || job?.error || "游戏文件下载失败，请重试下载";
    } else if (
      ["paused", "pausing"].includes(download?.status || job?.status || "")
    ) {
      phase = "paused";
      detail = "游戏文件下载已暂停，继续后将完成启动";
    } else if (currentStep?.name === "游戏运行") {
      phase = "running";
      detail = "游戏已启动 · 祝你玩得开心";
    } else {
      phase = "preparing";
      detail = currentStep?.detail || currentStep?.name || "正在准备游戏…";
      if (download && download.fileCount > 0) {
        detail += ` · ${download.completed} / ${download.fileCount} 个文件`;
      }
    }
  } else if (job?.status === "failed") {
    phase = "failed";
    detail = job.error || "上次启动未完成，请查看日志后重试";
  } else if (job?.status === "completed" || job?.status === "cancelled") {
    detail =
      currentStep?.name === "游戏运行"
        ? "游戏已结束，随时可以再次出发"
        : "启动已取消，可以重新出发";
  }

  return {
    job,
    download,
    active,
    phase,
    versionId: active ? job!.title.slice("启动 ".length) : selectedVersion,
    detail,
    progress,
    stepLabel:
      active && phase !== "running" && setupSteps.length
        ? `第 ${Math.min((job?.currentStep || 0) + 1, setupSteps.length)} / ${setupSteps.length} 步`
        : "",
  };
}
