import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Check,
  Hourglass,
  Pause,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Download, Job, Status, Tasks } from "./types";
import { getJobPresentation } from "./jobPresentation";

type ProgressInfo = {
  kind: "download" | "job";
  id: string;
  title: string;
  status: Status;
  label?: string;
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
  const presentation = getJobPresentation(task);
  return {
    kind: "job",
    id: task.id,
    title: task.title,
    status: presentation.status,
    label:
      presentation.label ??
      (presentation.status === "running"
        ? presentation.steps[task.currentStep]?.name
        : undefined),
    value:
      presentation.status === "completed"
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
    const job = tasks.jobs.find(
      (task) => getJobPresentation(task).status === status,
    );
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
    const hidden = { opacity: 0, transform: "scale(0.84)" };
    const shown = {
      opacity: 1,
      transform: "scale(1)",
    };
    const style = getComputedStyle(element);
    const from =
      motion.current || !visible
        ? {
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

// Clone only the previous committed layer. React owns the current content, so
// polling cannot restart an unchanged icon and interrupted swaps leave no ghosts.
function ProgressTransition({
  identity,
  kind = "text",
  children,
  className = "",
}: {
  identity: string;
  kind?: "icon" | "text" | "number";
  children: ReactNode;
  className?: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const current = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ identity: string; node: HTMLSpanElement } | null>(
    null,
  );
  useLayoutEffect(() => {
    const container = host.current,
      layer = current.current;
    if (!container || !layer) return;
    const source = previous.current;
    previous.current = {
      identity,
      node: layer.cloneNode(true) as HTMLSpanElement,
    };
    if (!source || source.identity === identity) return;
    const outgoing = source.node;
    outgoing.className = "sidebar-progress-outgoing";
    outgoing.setAttribute("aria-hidden", "true");
    container.append(outgoing);
    const icon = kind === "icon";
    const direction =
      kind === "number" && parseFloat(identity) < parseFloat(source.identity)
        ? -1
        : 1;
    const options = {
      duration: icon ? 280 : kind === "number" ? 220 : 240,
      easing: "cubic-bezier(.22,.8,.25,1)",
      fill: "both" as const,
    };
    const animations = [
      outgoing.animate(
        [
          { opacity: 1, transform: "translateY(0) scale(1) rotate(0)" },
          {
            opacity: 0,
            transform: icon
              ? "translateY(-2px) scale(.84) rotate(-12deg)"
              : `translateY(${-direction * 3}px)`,
          },
        ],
        { ...options, id: `sfmcl-t-sidebar-${kind}-out` },
      ),
      layer.animate(
        [
          {
            opacity: 0,
            transform: icon
              ? "translateY(2px) scale(.84) rotate(12deg)"
              : `translateY(${direction * 3}px)`,
          },
          { opacity: 1, transform: "translateY(0) scale(1) rotate(0)" },
        ],
        { ...options, id: `sfmcl-t-sidebar-${kind}-in` },
      ),
    ];
    if (icon && identity === "check") {
      const path = layer.querySelector("path");
      if (path) {
        path.setAttribute("pathLength", "1");
        path.setAttribute("stroke-dasharray", "1");
        animations.push(
          path.animate([{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], {
            duration: 440,
            easing: "ease-out",
            id: "sfmcl-t-sidebar-check",
          }),
        );
      }
    }
    const clear = () => {
      outgoing.remove();
      animations.forEach((animation) => animation.cancel());
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      clear,
      () => {},
    );
    return clear;
  }, [identity, kind]);
  return (
    <span
      ref={host}
      className={`sidebar-progress-switch ${className}`}
      data-transition={kind}
    >
      <span ref={current} className="sidebar-progress-current">
        {children}
      </span>
    </span>
  );
}

export function SidebarProgress({
  state,
  status,
}: {
  state: ReturnType<typeof useSidebarProgress>;
  status?: Status;
}) {
  const { info, present, visible, ref } = state;
  const taskStatus = present ? info?.status : status;
  const unknown = !!info && info.value === undefined;
  const icon =
    taskStatus === "completed"
      ? "check"
      : taskStatus === "failed"
        ? "triangle-alert"
        : taskStatus === "cancelled"
          ? "x"
          : taskStatus === "paused" || taskStatus === "pausing"
            ? "pause"
            : taskStatus === "queued" || (present && unknown)
              ? "hourglass"
              : "arrow-down";
  const Icon = {
    check: Check,
    "triangle-alert": TriangleAlert,
    x: X,
    pause: Pause,
    hourglass: Hourglass,
    "arrow-down": ArrowDown,
  }[icon];
  const stopped = taskStatus !== "running";
  return (
    <span
      className="sidebar-progress-icon"
      data-icon={icon}
      data-running={(present && !stopped && !unknown) || undefined}
    >
      {present && info && (
        <div
          ref={ref}
          className="sidebar-progress-motion"
          aria-hidden={!visible || undefined}
        >
          <span
            className="sidebar-progress"
            data-status={info.status}
            data-unknown={unknown || undefined}
            role="progressbar"
            aria-label={`${info.title}${info.kind === "download" ? "下载" : "步骤"}进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={info.value}
            aria-valuetext={
              info.value === undefined ? "正在获取任务进度" : `${info.value}%`
            }
          >
            <svg
              className="sidebar-progress-chart"
              viewBox="0 0 32 32"
              aria-hidden="true"
              data-spinning={(unknown && !stopped) || undefined}
            >
              <circle
                className="sidebar-progress-track"
                cx="16"
                cy="16"
                r="13"
              />
              <circle
                className="sidebar-progress-arc"
                cx="16"
                cy="16"
                r="13"
                pathLength="100"
                strokeDasharray="100"
                style={{
                  strokeDashoffset: unknown ? 75 : 100 - (info.value ?? 0),
                }}
              />
            </svg>
          </span>
        </div>
      )}
      <span className="sidebar-progress-glyph" aria-hidden="true">
        <ProgressTransition identity={icon} kind="icon">
          <Icon size={14} />
        </ProgressTransition>
      </span>
    </span>
  );
}

export function SidebarProgressCopy({
  value,
  label,
  present,
  visible,
}: {
  value?: number;
  label: string;
  present: boolean;
  visible: boolean;
}) {
  const target = value === undefined ? "···" : `${value}%`;
  const [displayed, setDisplayed] = useState(target);
  const lastStart = useRef(-Infinity);
  useEffect(() => {
    if (target === displayed) return;
    // Bound numeric updates so a fast stream still produces readable whole values.
    const timer = setTimeout(
      () => {
        lastStart.current = performance.now();
        setDisplayed(target);
      },
      Math.max(0, 300 - (performance.now() - lastStart.current)),
    );
    return () => clearTimeout(timer);
  }, [target, displayed]);
  return (
    <small className="sidebar-progress-copy">
      {present && (
        <span
          className="sidebar-progress-percent"
          data-visible={visible}
          aria-hidden="true"
        >
          <ProgressTransition identity={displayed} kind="number">
            {displayed}
          </ProgressTransition>
          <span className="sidebar-progress-separator"> · </span>
        </span>
      )}
      <ProgressTransition identity={label}>{label}</ProgressTransition>
    </small>
  );
}
