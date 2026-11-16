import { useApp } from "./store";
import { useTasks } from "./tasks";
import { statusLabel } from "./api";
import { PixelFrame } from "./components";
import {
  SidebarProgress,
  SidebarProgressCopy,
  useSidebarProgress,
} from "./SidebarProgress";

export function SidebarDownloads({
  railCollapsed,
}: {
  railCollapsed: boolean;
}) {
  const app = useApp();
  const tasks = useTasks();
  const sidebarProgress = useSidebarProgress(
    tasks,
    ["always", "active"].includes(app.data.settings.downloadTaskDisplay),
  );
  const showDownloadTasks =
    app.data.settings.downloadTaskDisplay === "always" ||
    (app.data.settings.downloadTaskDisplay === "active" &&
      (sidebarProgress.active || sidebarProgress.present));
  const download =
    tasks.downloads.find((d) => d.status === "running") ??
    tasks.downloads.find((d) => ["pausing", "queued"].includes(d.status)) ??
    tasks.downloads.find((d) => ["failed", "paused"].includes(d.status)) ??
    tasks.downloads[0];
  const task =
    (sidebarProgress.active || sidebarProgress.present
      ? sidebarProgress.info
      : undefined) ?? download;
  const progress = sidebarProgress.present
    ? sidebarProgress.info?.value
    : undefined;
  const downloadTitle = task?.title || "暂无下载任务";
  const taskStatusLabel = task
    ? "label" in task && task.label
      ? task.label
      : sidebarProgress.present &&
          progress === undefined &&
          task.status === "running"
        ? "等待进度"
        : statusLabel[task.status]
    : "准备好下一次出发";
  return (
    <>
      {showDownloadTasks && (
        <div className="sidebar-downloads" data-status={task?.status || "idle"}>
          <button
            className="sidebar-task has-surface"
            onClick={() => app.setPage("downloads")}
            aria-current={app.page === "downloads" ? "page" : undefined}
            aria-label={`下载中心：${downloadTitle}${task ? `，${taskStatusLabel}` : ""}`}
            data-tooltip={railCollapsed ? downloadTitle : undefined}
            data-tooltip-placement="right"
          >
            <PixelFrame />
            <SidebarProgress state={sidebarProgress} status={task?.status} />
            <span className="task-copy">
              <strong>{downloadTitle}</strong>
              <SidebarProgressCopy
                value={progress}
                label={taskStatusLabel}
                present={sidebarProgress.present}
                visible={sidebarProgress.visible}
              />
            </span>
          </button>
        </div>
      )}
    </>
  );
}
