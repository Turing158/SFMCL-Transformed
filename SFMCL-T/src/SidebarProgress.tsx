import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PixelFrame } from "./components";
import type { Download, Job, Status, Tasks } from "./types";

type ProgressInfo = {
  kind: "download" | "job";
  id: string;
  title: string;
  status: Status;
  value?: number;
};

const percent = (value: number) =>
  Math.round(Math.max(0, Math.min(1, value)) * 100);

function downloadInfo(task: Download): ProgressInfo {
  return {
    kind: "download",
    id: task.id,
    title: task.title,
    status: task.status,
    value:
      task.status === "completed"
        ? 100
        : !task.unknownSize && task.total > 0
          ? percent(task.downloaded / task.total)
          : task.fileCount > 0
            ? percent(task.completed / task.fileCount)
            : undefined,
  };
}

function jobInfo(task: Job): ProgressInfo {
  return {
    kind: "job",
    id: task.id,
    title: task.title,
    status: task.status,
    value:
      task.status === "completed"
        ? 100
        : task.steps.length > 0
          ? percent(
              task.steps.filter((step) => step.status === "completed").length /
                task.steps.length,
            )
          : undefined,
  };
}

function currentProgress(tasks: Tasks) {
  for (const status of ["running", "pausing", "queued", "paused"] as const) {
    const download = tasks.downloads.find((task) => task.status === status);
    if (download) return downloadInfo(download);
    const job = tasks.jobs.find((task) => task.status === status);
    if (job) return jobInfo(job);
  }
  return undefined;
}

export function useSidebarProgress(tasks: Tasks, enabled: boolean) {
  const current = useMemo(() => currentProgress(tasks), [tasks]);
  const active = enabled && !!current;
  const [last, setLast] = useState(current);
  const [visible, setVisible] = useState(active);
  const [present, setPresent] = useState(active);
  const ref = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    setLast((previous) => {
      if (current) return current;
      if (!previous) return previous;
      // Keep the final frame even if the task is cleared during the delay.
      if (previous.kind === "download") {
        const task = tasks.downloads.find((task) => task.id === previous.id);
        return task ? downloadInfo(task) : previous;
      }
      const task = tasks.jobs.find((task) => task.id === previous.id);
      return task ? jobInfo(task) : previous;
    });
  }, [tasks, current]);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      setPresent(false);
      return;
    }
    if (active) {
      setVisible(true);
      return;
    }
    // Depend on activity, not polling snapshots, so idle polls cannot reset it.
    const timer = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(timer);
  }, [active, enabled]);

  useLayoutEffect(() => {
    if (visible && !present) {
      setPresent(true);
      return;
    }
    const element = ref.current;
    if (!element) {
      motion.current?.cancel();
      motion.current = null;
      if (!visible) setPresent(false);
      return;
    }
    const hidden = { height: "0px", opacity: 0, transform: "translateY(-4px)" };
    const shown = {
      height: `${element.scrollHeight}px`,
      opacity: 1,
      transform: "translateY(0)",
    };
    const style = getComputedStyle(element);
    const from =
      motion.current || !visible
        ? {
            height: style.height,
            opacity: style.opacity,
            transform: style.transform,
          }
        : hidden;
    motion.current?.cancel();
    const animation = element.animate([from, visible ? shown : hidden], {
      id: `sfmcl-t-sidebar-progress-${visible ? "enter" : "exit"}`,
      duration: 240,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both",
    });
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

  return { info: current ?? last, active, visible, present, ref };
}

export function SidebarProgress({
  state,
}: {
  state: ReturnType<typeof useSidebarProgress>;
}) {
  const { info, present, visible, ref } = state;
  if (!present || !info) return null;
  return (
    <div
      ref={ref}
      className="sidebar-progress-motion"
      aria-hidden={!visible || undefined}
    >
      <div
        className="sidebar-progress has-surface"
        data-status={info.status}
        role="progressbar"
        aria-label={`${info.title}${info.kind === "download" ? "下载" : "步骤"}进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={info.value}
        aria-valuetext={
          info.value === undefined ? "正在获取任务进度" : `${info.value}%`
        }
      >
        <PixelFrame />
        <span
          className="sidebar-progress-fill has-surface"
          style={{ width: `${info.value ?? 100}%` }}
          aria-hidden="true"
        >
          <PixelFrame />
        </span>
      </div>
    </div>
  );
}
