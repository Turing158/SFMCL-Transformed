import { useLayoutEffect, useRef, useState } from "react";
import { useApp } from "./store";
import { useOnboarding } from "./Onboarding";
import { useTasks } from "./tasks";
import { statusLabel } from "./api";
import { PixelFrame } from "./components";
import {
  SidebarProgress,
  SidebarProgressCopy,
  useSidebarProgress,
} from "./SidebarProgress";

function useDownloadEntryPresence(visible: boolean) {
  const [present, setPresent] = useState(visible);
  const ref = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    if (visible && !present) {
      setPresent(true);
      return;
    }
    const element = ref.current;
    if (!element) {
      motion.current?.cancel();
      motion.current = null;
      return;
    }
    // One value moves the card and its layout space together. Read the current
    // frame before cancelling so new work can reverse an unfinished exit.
    const from =
      motion.current || !visible
        ? getComputedStyle(element).getPropertyValue("--sidebar-task-open")
        : "0";
    motion.current?.cancel();
    const animation = element.animate(
      [
        { "--sidebar-task-open": from },
        { "--sidebar-task-open": visible ? "1" : "0" },
      ],
      {
        id: `sfmcl-t-sidebar-task-${visible ? "enter" : "exit"}`,
        duration: 300,
        easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
        fill: "both",
      },
    );
    motion.current = animation;
    animation.onfinish = () => {
      if (motion.current !== animation) return;
      if (visible) {
        motion.current = null;
        animation.cancel();
      } else {
        setPresent(false);
      }
    };
  }, [visible, present]);

  useLayoutEffect(
    () => () => {
      motion.current?.cancel();
      motion.current = null;
    },
    [],
  );
  return { present, ref };
}

export function SidebarDownloads({
  railCollapsed,
}: {
  railCollapsed: boolean;
}) {
  const app = useApp();
  const { step } = useOnboarding();
  const tasks = useTasks();
  const sidebarProgress = useSidebarProgress(
    tasks,
    ["always", "active"].includes(app.data.settings.downloadTaskDisplay),
  );
  const showDownloadTasks =
    step === "downloads" ||
    app.data.settings.downloadTaskDisplay === "always" ||
    (app.data.settings.downloadTaskDisplay === "active" &&
      (sidebarProgress.active || sidebarProgress.visible));
  const entry = useDownloadEntryPresence(showDownloadTasks);
  const download =
    tasks.downloads.find((d) => d.status === "running") ??
    tasks.downloads.find((d) => ["pausing", "queued"].includes(d.status)) ??
    tasks.downloads.find((d) => ["failed", "paused"].includes(d.status)) ??
    tasks.downloads[0];
  const task =
    (sidebarProgress.active ||
    sidebarProgress.present ||
    (entry.present && !showDownloadTasks)
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
      {entry.present && (
        <div
          ref={entry.ref}
          className="sidebar-downloads"
          data-status={task?.status || "idle"}
          data-visible={showDownloadTasks}
          inert={!showDownloadTasks}
          aria-hidden={!showDownloadTasks || undefined}
        >
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
