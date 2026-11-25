import type { Job, Status, Step } from "./types";

// A launch task can be visually complete while its process stays monitored.
export function getJobPresentation(job: Job): {
  status: Status;
  label?: string;
  steps: Step[];
} {
  if (job.launch && job.gameExit) {
    return {
      status: job.status,
      label:
        job.commandRuns?.postExit.status === "running"
          ? "收尾中"
          : job.status === "completed"
            ? "已结束"
            : undefined,
      steps: job.steps,
    };
  }
  const started =
    !!job.launch &&
    (job.status === "completed" ||
      (job.status === "running" && job.launch.running));
  if (!started) return { status: job.status, steps: job.steps };
  return {
    status: "completed",
    label: "已启动",
    steps: job.steps.map((step, index) =>
      index === job.currentStep
        ? { ...step, name: "已启动", status: "completed", detail: "游戏已启动" }
        : step,
    ),
  };
}
