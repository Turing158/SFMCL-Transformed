import { useSessionState } from "./windowSession";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ComponentProps,
  CSSProperties,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import {
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  LoaderCircle,
  Play,
  Pause,
  Plus,
  RotateCw,
  Search,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { api } from "./api";
import { Badge, Button, PixelFrame, ResourceImage } from "./components";
import { SearchField } from "./controls";
import { getLaunchTask, isActiveLaunch } from "./launchState";
import { versionIcon } from "./versionIcon";
import { versionPayload } from "./versionActions";
import { gameDirectoryName, gameDirectoryPath } from "./gameDirectories";
import { useApp } from "./store";
import { useTasks } from "./tasks";
import { FooterText } from "./FooterText";
import { useLaunchDisclosure } from "./useLaunchDisclosure";
import { useVersionPickerPopup } from "./useVersionPickerPopup";
import type { Tasks, Version } from "./types";
import "./launch-dock.css";

type PendingAction = {
  kind: "launch" | "cancel" | "resume";
  jobId?: string;
  requested: boolean;
  snapshot: Tasks;
};

type CardDrag = {
  element: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
  expanded: boolean;
  height: number;
  startHeight: number;
  moving: boolean;
};

function LaunchButton({
  children,
  onClick,
  ...props
}: ComponentProps<typeof Button>) {
  const pulse = useRef<HTMLSpanElement>(null);
  const feedback = useRef<Animation | null>(null);

  useEffect(() => () => feedback.current?.cancel(), []);

  return (
    <Button
      {...props}
      onClick={(event) => {
        // Native clicks cover pointer, touch and keyboard activation alike.
        feedback.current?.cancel();
        feedback.current =
          pulse.current?.animate(
            [
              { opacity: 0, transform: "scale(0.12, 0.55)" },
              { opacity: 1, transform: "scale(0.36, 1)", offset: 0.2 },
              { opacity: 0, transform: "scale(1, 1)" },
            ],
            { duration: 300, easing: "steps(8, end)" },
          ) ?? null;
        onClick?.(event);
      }}
    >
      {children}
      <span className="launch-control-fx" aria-hidden="true">
        <span ref={pulse} className="launch-control-pulse" />
      </span>
    </Button>
  );
}

export function LaunchDock({
  active,
  playerCaption,
}: {
  active: boolean;
  playerCaption: string;
}) {
  const app = useApp();
  const tasks = useTasks();
  const settings = app.data.settings;
  const [collapsedGames, setCollapsedGames] = useSessionState<
    Record<string, { icon: string; startedAt: number }>
  >("LaunchDock.collapsedGames", {});
  const [processesOpen, setProcessesOpen] = useSessionState(
    "LaunchDock.processesOpen",
    false,
  );
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const cardDrag = useRef<CardDrag | null>(null);
  const suppressDragClick = useRef(false);
  const [stoppingGames, setStoppingGames] = useState<string[]>([]);
  const stopRequests = useRef(new Set<string>());
  const task = getLaunchTask(
    tasks,
    settings.activeVersion,
    Object.keys(collapsedGames),
  );
  const processes = tasks.jobs.filter(
    (job) => collapsedGames[job.id] && isActiveLaunch(job, tasks.downloads),
  );
  const processesExpanded = processesOpen && processes.length > 0;
  const version = app.versions.find((item) => item.id === task.versionId);
  const player = app.data.players.find(
    (item) => item.uuid === settings.activePlayer,
  );
  const [pickerOpen, setPickerOpen] = useSessionState(
    "LaunchDock.pickerOpen",
    false,
  );
  const [pickerPresent, setPickerPresent] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [progressSnapshot, setProgressSnapshot] = useState({
    jobId: "",
    progress: 0,
  });
  const [actionError, setActionError] = useState<{
    context: string;
    message: string;
  } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const dock = useRef<HTMLElement>(null);
  const disclosure = useLaunchDisclosure({
    host: dock,
    expanded: processesExpanded,
    dragHeight,
    active,
    count: processes.length,
  });
  const actions = useRef<HTMLDivElement>(null);
  const requestInFlight = useRef(false);
  const focusWhenReady = useRef(false);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const pickerId = useId();
  const statusId = useId();
  const processesId = useId();
  const context = `${settings.activeDir}\n${settings.activeVersion}\n${settings.activePlayer}`;
  const localError =
    actionError?.context === context ? actionError.message : "";
  const locked = task.active || !!pending;
  const versionSelection = `${settings.activeDir}\n${settings.activeVersion}`;
  const previousSelection = useRef({
    key: versionSelection,
    versions: app.versions,
    runningJobIds: [] as string[],
  });

  useLayoutEffect(() => {
    const previous = previousSelection.current;
    const running = tasks.jobs.filter(
      (job) =>
        !collapsedGames[job.id] &&
        isActiveLaunch(job, tasks.downloads) &&
        (job.launch?.running ??
          job.steps[job.currentStep]?.name === "游戏运行"),
    );
    previousSelection.current = {
      key: versionSelection,
      versions: app.versions,
      runningJobIds: running.map((job) => job.id),
    };
    if (previous.key === versionSelection) return;
    const games = running.filter((job) =>
      previous.runningJobIds.includes(job.id),
    );
    if (!games.length) return;
    // Keep the old directory's icons when a selection refresh replaces versions.
    setCollapsedGames((current) => {
      const next = { ...current };
      for (const job of games) {
        const id = job.launch?.versionId ?? job.title.slice("启动 ".length);
        next[job.id] = {
          icon:
            versionIcon(previous.versions.find((item) => item.id === id)) ||
            "/assets/DefaultGameIcon/Minecraft.png",
          startedAt: job.createdAt ? job.createdAt * 1000 : Date.now(),
        };
      }
      return next;
    });
    setProcessesOpen(false);
  }, [versionSelection, tasks, app.versions, collapsedGames]);

  useEffect(() => {
    for (const id of stopRequests.current) {
      if (
        !tasks.jobs.some(
          (job) => job.id === id && isActiveLaunch(job, tasks.downloads),
        )
      ) {
        stopRequests.current.delete(id);
        setStoppingGames((current) => current.filter((item) => item !== id));
      }
    }
    setCollapsedGames((current) => {
      const entries = Object.entries(current).filter(([id]) =>
        tasks.jobs.some(
          (job) => job.id === id && isActiveLaunch(job, tasks.downloads),
        ),
      );
      return entries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(entries);
    });
  }, [tasks]);

  const closePicker = useCallback((restoreFocus = true) => {
    setPickerOpen(false);
    focusWhenReady.current = false;
    if (restoreFocus) {
      const trigger =
        actions.current?.querySelector<HTMLButtonElement>(".launch-switch");
      if (trigger?.disabled) focusWhenReady.current = true;
      else trigger?.focus({ preventScroll: true });
    }
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      closePicker(false);
      setPickerPresent(false);
      return;
    }
    if (focusWhenReady.current && !pickerOpen && !app.busy && !selecting) {
      focusWhenReady.current = false;
      actions.current
        ?.querySelector<HTMLButtonElement>(".launch-switch")
        ?.focus({ preventScroll: true });
    }
  }, [active, pickerOpen, app.busy, selecting, closePicker]);

  useLayoutEffect(() => {
    const footer = dock.current;
    const root = footer?.closest<HTMLElement>(".app");
    if (!footer || !root) return;
    const measure = () =>
      root.style.setProperty(
        "--launch-dock-height",
        `${footer.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--launch-dock-height");
    };
  }, []);

  useEffect(() => {
    if (locked) closePicker(false);
  }, [locked, closePicker]);

  useEffect(() => {
    if (active && processes.length > 0) return;
    const drag = cardDrag.current;
    cardDrag.current = null;
    setDragHeight(null);
    if (drag?.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId);
    }
  }, [active, processes.length]);

  function startCardDrag(event: ReactPointerEvent<HTMLDivElement>) {
    suppressDragClick.current = false;
    if (
      !active ||
      !processes.length ||
      cardDrag.current ||
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest(
          "button, a, input, textarea, select, [role='button'], [contenteditable]",
        ))
    )
      return;
    const clip = dock.current?.querySelector<HTMLElement>(
      ".launch-processes-clip",
    );
    if (!clip) return;
    // Measure the content's capped natural height without painting it open.
    const hidden = clip.hidden;
    const startHeight = disclosure.freeze();
    clip.hidden = false;
    const height =
      (clip.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    clip.hidden = hidden;
    if (!height) return;
    cardDrag.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      expanded: processesExpanded,
      height,
      startHeight,
      moving: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveCardDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = cardDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = drag.startY - event.clientY;
    if (!drag.moving) {
      if (
        Math.abs(distance) < 6 ||
        Math.abs(event.clientX - drag.startX) > Math.abs(distance)
      )
        return;
      drag.moving = true;
      closePicker(false);
    }
    event.preventDefault();
    setDragHeight(
      Math.max(0, Math.min(drag.height, drag.startHeight + distance)),
    );
  }

  function finishCardDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) {
    const drag = cardDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cardDrag.current = null;
    setDragHeight(null);
    if (drag.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId);
    }
    if (!drag.moving) {
      disclosure.resume();
      return;
    }
    suppressDragClick.current = !cancelled;
    const distance = drag.startY - event.clientY;
    const threshold = Math.min(32, drag.height / 3);
    setProcessesOpen(
      cancelled
        ? drag.expanded
        : drag.expanded
          ? distance > -threshold
          : distance >= threshold,
    );
  }

  useEffect(() => {
    if (!pending?.requested || !pending.jobId) return;
    const job = tasks.jobs.find((item) => item.id === pending.jobId);
    if (!job) return;
    const settled =
      pending.kind === "launch" ||
      (pending.kind === "cancel" && !isActiveLaunch(job, tasks.downloads)) ||
      (pending.kind === "resume" && tasks !== pending.snapshot);
    if (settled) setPending(null);
  }, [tasks, pending]);

  const mode = pending
    ? pending.kind === "cancel"
      ? "cancelling"
      : "preparing"
    : task.active
      ? task.phase
      : !version
        ? "empty"
        : version.error
          ? "invalid"
          : !player
            ? "no-player"
            : localError || task.phase === "failed"
              ? "failed"
              : "ready";
  const busy = app.busy || selecting || !!pending;
  const message =
    localError ||
    (pending
      ? pending.kind === "cancel"
        ? "正在结束任务，请稍候…"
        : pending.kind === "resume"
          ? "正在恢复游戏文件下载…"
          : pending.requested
            ? "正在读取启动进度…"
            : "正在验证账号并请求启动…"
      : mode === "empty"
        ? "开始之前，请先选择一个游戏版本"
        : mode === "invalid"
          ? version!.error!
          : mode === "no-player"
            ? "版本已就绪，选择一个角色即可出发"
            : task.detail);
  const warning = ["empty", "invalid", "no-player", "paused"].includes(mode);
  const failure =
    !!localError || ["failed", "download-error", "invalid"].includes(mode);
  const spinning = ["preparing", "cancelling"].includes(mode);
  const showProgress = locked && mode !== "running";
  const indeterminate =
    mode === "preparing" && (!task.active || task.progress === undefined);
  const progressJobId = task.active ? task.job!.id : "";
  const reportedProgress = task.active
    ? mode === "running"
      ? 100
      : Math.max(0, Math.min(100, task.progress ?? 0))
    : 0;
  const activeProgress =
    progressSnapshot.jobId === progressJobId
      ? Math.max(progressSnapshot.progress, reportedProgress)
      : reportedProgress;
  // Recalculated download totals can lower a report without undoing completed work.
  // Retain this job's highest value and reset before rendering another job.
  if (
    progressSnapshot.jobId !== progressJobId ||
    progressSnapshot.progress !== activeProgress
  ) {
    setProgressSnapshot({ jobId: progressJobId, progress: activeProgress });
  }
  const buttonProgress = task.active
    ? activeProgress
    : mode === "ready" || mode === "preparing"
      ? 0
      : 100;
  const buttonDetail = [message, task.stepLabel].filter(Boolean).join(" · ");
  const PrimaryIcon =
    mode === "running"
      ? Square
      : spinning
        ? LoaderCircle
        : mode === "no-player"
          ? UserRound
          : mode === "invalid"
            ? FolderOpen
            : ["failed", "download-error"].includes(mode)
              ? RotateCw
              : mode === "paused"
                ? Pause
                : Play;
  const primaryText =
    mode === "running"
      ? "结束游戏"
      : mode === "cancelling"
        ? "正在结束"
        : mode === "preparing"
          ? indeterminate
            ? "正在启动"
            : `正在启动 ${Math.round(buttonProgress)}%`
          : mode === "empty"
            ? "选择版本"
            : mode === "no-player"
              ? "选择角色"
              : mode === "invalid"
                ? "管理版本"
                : mode === "failed"
                  ? "重试启动"
                  : mode === "download-error"
                    ? "重试下载"
                    : mode === "paused"
                      ? "继续启动"
                      : "开始游戏";

  async function request(kind: PendingAction["kind"]) {
    if (requestInFlight.current || app.busy || pending) return;
    const jobId = task.job?.id;
    if (kind !== "launch" && !jobId) return;
    if (kind === "resume" && !task.download) {
      app.setPage("downloads");
      return;
    }
    if (
      kind === "launch" &&
      (task.active || !version || version.error || !player)
    )
      return;
    requestInFlight.current = true;
    setActionError(null);
    closePicker(false);
    setPending({ kind, jobId, requested: false, snapshot: tasks });
    try {
      await app.run(async () => {
        try {
          let id = jobId;
          if (kind === "launch") id = await api<string>("launch");
          else if (kind === "cancel") await api("jobs.cancel", { id: jobId });
          else
            await api("downloads.control", {
              id: task.download!.id,
              action: "resume",
            });
          setPending({
            kind,
            jobId: id,
            requested: true,
            snapshot: tasksRef.current,
          });
        } catch (error) {
          setPending(null);
          setActionError({ context, message: String(error) });
          throw error;
        }
      });
    } finally {
      requestInFlight.current = false;
    }
  }

  function primaryAction() {
    if (mode === "no-player") app.setPage("players");
    else if (mode === "invalid") app.setPage("versions");
    else if (mode === "running") void request("cancel");
    else if (mode === "paused" || mode === "download-error")
      void request("resume");
    else void request("launch");
  }

  function collapseGame() {
    if (mode !== "running" || !task.job || busy) return;
    const job = task.job;
    setCollapsedGames((current) => ({
      ...current,
      [job.id]: {
        icon: versionIcon(version) || "/assets/DefaultGameIcon/Minecraft.png",
        startedAt: job.createdAt ? job.createdAt * 1000 : Date.now(),
      },
    }));
    setProcessesOpen(false);
  }

  function restoreGame(id: string) {
    const job = tasksRef.current.jobs.find((item) => item.id === id);
    if (
      busy ||
      requestInFlight.current ||
      stopRequests.current.has(id) ||
      !collapsedGames[id] ||
      !job ||
      !isActiveLaunch(job, tasksRef.current.downloads) ||
      (task.active && mode !== "running")
    )
      return;
    closePicker(false);
    setActionError(null);
    setCollapsedGames((current) => {
      const next = { ...current };
      if (task.active && task.job && task.job.id !== id) {
        next[task.job.id] = {
          icon: versionIcon(version) || "/assets/DefaultGameIcon/Minecraft.png",
          startedAt: task.job.createdAt
            ? task.job.createdAt * 1000
            : Date.now(),
        };
      }
      delete next[id];
      return next;
    });
    setProcessesOpen(false);
    actions.current
      ?.querySelector<HTMLButtonElement>(".launch-primary")
      ?.focus({ preventScroll: true });
  }

  async function stopGame(id: string) {
    const job = tasksRef.current.jobs.find((item) => item.id === id);
    if (!job || !isActiveLaunch(job, tasksRef.current.downloads)) return;
    if (stopRequests.current.has(id) || app.busy || pending) return;
    stopRequests.current.add(id);
    setStoppingGames((current) => [...current, id]);
    let cancelled = false;
    try {
      await app.run(async () => {
        await api("jobs.cancel", { id });
        cancelled = true;
      });
    } finally {
      if (!cancelled) {
        stopRequests.current.delete(id);
        setStoppingGames((current) => current.filter((item) => item !== id));
      }
    }
  }

  const canCancel = locked && mode !== "running";
  const showPicker = () => {
    if (locked || app.busy || requestInFlight.current) return;
    if (localError) app.clearError();
    setSelectionError("");
    setPickerPresent(true);
    setPickerOpen((open) => !open);
  };
  const selectVersion = async (item: Version) => {
    if (locked || app.busy || requestInFlight.current || item.error) return;
    if (
      item.id === settings.activeVersion &&
      (item.directory ?? settings.activeDir) === settings.activeDir
    ) {
      closePicker();
      return;
    }
    requestInFlight.current = true;
    dock.current
      ?.querySelector<HTMLInputElement>(".launch-version-picker input")
      ?.focus({ preventScroll: true });
    setSelecting(true);
    setSelectionError("");
    try {
      await app.run(async () => {
        try {
          await app.update("versions.select", versionPayload(item));
          setActionError(null);
          closePicker();
          app.notify(`已切换到 ${item.id}`);
        } catch (error) {
          if (dock.current?.querySelector(".launch-version-picker")) {
            setSelectionError(`版本切换失败：${String(error)}`);
          } else {
            throw error;
          }
        }
      });
    } finally {
      requestInFlight.current = false;
      setSelecting(false);
    }
  };

  return (
    <footer
      ref={dock}
      className="launch-dock"
      aria-label="游戏启动区"
      aria-hidden={!active}
      inert={!active}
      data-state={mode}
      data-error={failure || undefined}
      data-warning={warning || undefined}
      data-has-processes={processes.length > 0 || undefined}
      data-processes-expanded={processesExpanded || undefined}
      data-dragging={dragHeight !== null || undefined}
    >
      <div className="launch-dock-shadow">
        <div className="launch-dock-card">
          <div
            className="launch-dock-main"
            data-job-id={task.active ? task.job?.id : undefined}
            onPointerDown={startCardDrag}
            onPointerMove={moveCardDrag}
            onPointerUp={(event) => finishCardDrag(event)}
            onPointerCancel={(event) => finishCardDrag(event, true)}
            onLostPointerCapture={(event) => finishCardDrag(event, true)}
            onDragStart={(event) => {
              if (processes.length) event.preventDefault();
            }}
            onClickCapture={(event) => {
              if (!suppressDragClick.current || event.detail === 0) return;
              suppressDragClick.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              className="launch-process-toggle"
              aria-expanded={processesExpanded}
              aria-controls={processesId}
              aria-hidden={!processes.length}
              disabled={!processes.length}
              inert={!processes.length}
              onClick={() => {
                closePicker(false);
                setProcessesOpen((open) => !open);
              }}
            >
              <span className="launch-process-toggle-content">
                {processesExpanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronUp size={14} aria-hidden="true" />
                )}
                {processesExpanded ? "收起" : "展开"}
              </span>
            </button>
            <div className="launch-version">
              <ResourceImage
                path={versionIcon(version)}
                alt={version?.loader || "Minecraft"}
              />
              <div className="launch-version-copy">
                <div className="launch-version-title">
                  <h3
                    data-tooltip={
                      (task.active ? task.versionId : version?.id) ||
                      "选择你的第一个版本"
                    }
                  >
                    {(task.active ? task.versionId : version?.id) ||
                      "选择你的第一个版本"}
                  </h3>
                </div>
                {version ? (
                  <div className="launch-version-tags">
                    <Badge className="launch-loader">
                      {version.loader === "Vanilla" ? "原版" : version.loader}
                    </Badge>
                    <Badge className="launch-java">
                      Java {version.javaMajor}
                    </Badge>
                  </div>
                ) : (
                  !task.active && <p>添加已有游戏，或安装一个全新的世界。</p>
                )}
              </div>
            </div>
            <div ref={actions} className="launch-actions">
              <LaunchButton
                className="launch-switch"
                aria-haspopup={!locked ? "dialog" : undefined}
                aria-expanded={!locked ? pickerOpen : undefined}
                aria-controls={!locked ? pickerId : undefined}
                disabled={busy}
                onClick={() => {
                  if (mode === "running") collapseGame();
                  else if (canCancel) void request("cancel");
                  else showPicker();
                }}
              >
                {mode === "running"
                  ? "继续启动"
                  : canCancel
                    ? "取消启动"
                    : version
                      ? "切换版本"
                      : "选择版本"}
                {canCancel ? (
                  <X size={16} />
                ) : mode === "running" ? (
                  <Plus size={16} />
                ) : (
                  <ChevronUp size={16} />
                )}
              </LaunchButton>
              <LaunchButton
                primary
                className="launch-primary"
                aria-label={primaryText}
                aria-describedby={statusId}
                aria-busy={spinning}
                data-tooltip={buttonDetail}
                data-indeterminate={indeterminate || undefined}
                data-progress-active={task.active || undefined}
                style={
                  {
                    "--launch-button-progress": `${buttonProgress}%`,
                  } as CSSProperties
                }
                disabled={busy || mode === "empty" || spinning}
                onClick={primaryAction}
              >
                <span className="launch-button-surface" aria-hidden="true">
                  <span className="launch-button-layer launch-button-base">
                    <PrimaryIcon
                      size={17}
                      className={spinning ? "spin" : undefined}
                      fill={PrimaryIcon === Play ? "currentColor" : "none"}
                    />
                    <span>{primaryText}</span>
                  </span>
                  <span className="launch-button-layer launch-button-fill">
                    <PrimaryIcon
                      size={17}
                      className={spinning ? "spin" : undefined}
                      fill={PrimaryIcon === Play ? "currentColor" : "none"}
                    />
                    <span
                      className="launch-button-fill-label"
                      data-label={primaryText}
                    />
                  </span>
                </span>
                {showProgress && (
                  <span
                    className="sr-only"
                    role="progressbar"
                    aria-label="游戏启动步骤进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={indeterminate ? undefined : buttonProgress}
                    aria-valuetext={buttonDetail}
                  />
                )}
              </LaunchButton>
              <span id={statusId} className="sr-only" role="status">
                {buttonDetail}
              </span>
            </div>
          </div>
          {processes.length > 0 && (
            <div ref={disclosure.clip} className="launch-processes-clip">
              <section
                id={processesId}
                className="launch-processes"
                aria-label="收起的游戏进程"
                inert={!processesExpanded || dragHeight !== null}
              >
                <div
                  className="launch-process-grid"
                  role="list"
                  aria-label="运行中的游戏"
                >
                  {processes.map((job) => {
                    const name =
                      job.launch?.versionId ?? job.title.slice("启动 ".length);
                    const stopping = stoppingGames.includes(job.id);
                    const startedAt = new Date(
                      collapsedGames[job.id].startedAt,
                    );
                    const time = startedAt.toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    });
                    return (
                      <article
                        key={job.id}
                        className="launch-process-card has-surface"
                        role="listitem"
                        data-job-id={job.id}
                      >
                        <PixelFrame />
                        <button
                          type="button"
                          className="launch-process-restore"
                          aria-label={`查看运行中的游戏 ${name}`}
                          disabled={
                            busy ||
                            stopping ||
                            (task.active && mode !== "running")
                          }
                          onClick={() => restoreGame(job.id)}
                        >
                          <ResourceImage
                            path={collapsedGames[job.id].icon}
                            alt="Minecraft"
                          />
                          <div className="launch-process-copy">
                            <strong data-tooltip={name}>{name}</strong>
                            <time
                              dateTime={startedAt.toISOString()}
                              data-tooltip={`启动时间：${time}`}
                            >
                              启动于 {time}
                            </time>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="icon-button launch-process-stop"
                          aria-label={`结束游戏 ${name}`}
                          aria-busy={stopping}
                          data-tooltip={stopping ? "正在结束游戏" : "结束游戏"}
                          disabled={busy || stopping}
                          onClick={() => void stopGame(job.id)}
                        >
                          {stopping ? (
                            <LoaderCircle
                              size={16}
                              className="spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <Square size={16} aria-hidden="true" />
                          )}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
      {active && (
        <div className="launch-status">
          {player && (
            <span className="launch-status-player" data-tooltip={playerCaption}>
              <UserRound size={12} aria-hidden="true" />
              <FooterText slot="player" text={playerCaption} />
            </span>
          )}
        </div>
      )}
      {active && pickerPresent && (
        <VersionPicker
          id={pickerId}
          actions={actions}
          open={pickerOpen}
          onExited={() => setPickerPresent(false)}
          disabled={busy}
          error={selectionError}
          onClose={closePicker}
          onSelect={(item) => void selectVersion(item)}
          onInstall={() => {
            closePicker();
            app.openResources("minecraft");
          }}
        />
      )}
    </footer>
  );
}

function VersionPicker({
  id,
  actions,
  open,
  onExited,
  disabled,
  error,
  onClose,
  onSelect,
  onInstall,
}: {
  id: string;
  actions: RefObject<HTMLDivElement | null>;
  open: boolean;
  onExited: () => void;
  disabled: boolean;
  error: string;
  onClose: (restoreFocus?: boolean) => void;
  onSelect: (version: Version) => void;
  onInstall: () => void;
}) {
  const app = useApp();
  const [query, setQuery] = useSessionState("VersionPicker.query", "");
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const needle = query.trim().toLowerCase();
  const settings = app.data.settings;
  const showAll = app.showAllVersions;
  const catalog = showAll ? app.allVersions.versions : app.versions;
  const loading = showAll && app.allVersions.loading;
  const directoryName = (item: Version) =>
    gameDirectoryName(
      settings.gameDirs.find(
        (directory) => directory.path === item.directory,
      ) ?? {
        name: item.directory ?? settings.activeDir,
        path: item.directory ?? settings.activeDir,
      },
    );
  const selected = (item: Version) =>
    item.id === settings.activeVersion &&
    (item.directory ?? settings.activeDir) === settings.activeDir;
  const versions = catalog.filter((item) =>
    `${item.id} ${item.version} ${item.loader === "Vanilla" ? "原版 Vanilla" : item.loader} Java ${item.javaMajor} ${showAll ? `${directoryName(item)} ${item.directory}` : ""}`
      .toLowerCase()
      .includes(needle),
  );
  const focusablePath =
    versions.find((item) => !item.error && selected(item))?.path ||
    versions.find((item) => !item.error)?.path;
  const versionKeys = versions.map((item) => item.path).join("\n");
  useVersionPickerPopup(panel, actions, open, onExited);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const remaining = element.scrollHeight - element.clientHeight;
      const overflow = element.clientHeight > 0 && remaining > 1;
      const next = {
        top: overflow && element.scrollTop > 1,
        bottom: overflow && remaining - element.scrollTop > 1,
      };
      setScrollEdges((previous) =>
        previous.top === next.top && previous.bottom === next.bottom
          ? previous
          : next,
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    Array.from(element.children).forEach((item) => observer.observe(item));
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [versionKeys]);

  useLayoutEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLInputElement>("input")
      ?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      const trigger = actions.current?.querySelector(".launch-switch");
      if (
        !panel.current?.contains(event.target) &&
        !trigger?.contains(event.target)
      )
        onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [actions, onClose, open]);

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const options = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ) || []),
    ];
    if (!options.length) return;
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const inSearch = event.target instanceof HTMLInputElement;
    if (current < 0 && !inSearch) return;
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (current + 1) % options.length;
    else if (event.key === "ArrowUp")
      next = current <= 0 ? options.length - 1 : current - 1;
    else if (event.key === "Home" && !inSearch) next = 0;
    else if (event.key === "End" && !inSearch) next = options.length - 1;
    else if (event.key === "Enter" && inSearch) {
      event.preventDefault();
      options[0].click();
      return;
    }
    if (next !== undefined) {
      event.preventDefault();
      options.forEach((option, index) => {
        option.tabIndex = index === next ? 0 : -1;
      });
      options[next].focus({ preventScroll: true });
      options[next].scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div
      ref={panel}
      id={id}
      className="launch-version-picker panel has-surface"
      popover={"showPopover" in HTMLElement.prototype ? "manual" : undefined}
      data-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open || undefined}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      onKeyDown={keyboard}
    >
      <PixelFrame />
      <header className="launch-picker-heading">
        <div>
          <h2 id={`${id}-title`}>选择游戏版本</h2>
          <p>
            {catalog.length} 个版本{showAll && " · 全部"}
          </p>
        </div>
        <SearchField
          label="搜索本地版本"
          placeholder="搜索版本或加载器…"
          value={query}
          onValueChange={setQuery}
          resultCount={versions.length}
        />
      </header>
      {error && (
        <p className="launch-picker-error" role="alert">
          {error}
        </p>
      )}
      {showAll && app.allVersions.errors.length > 0 && (
        <p className="launch-picker-error" role="alert">
          部分目录读取失败，已显示其余版本。
          <span data-tooltip={app.allVersions.errors.join("\n")}>详情</span>
          <Button
            disabled={disabled || loading}
            onClick={app.allVersions.refresh}
          >
            重新读取
          </Button>
        </p>
      )}
      <div
        className="launch-version-viewport"
        hidden={versions.length === 0}
        data-scroll-top={scrollEdges.top || undefined}
        data-scroll-bottom={scrollEdges.bottom || undefined}
      >
        <div
          ref={list}
          className="launch-version-list"
          role="listbox"
          aria-label="本地游戏版本"
          aria-busy={disabled || loading}
        >
          {versions.map((item) => (
            <button
              key={item.path}
              type="button"
              className="launch-version-option has-surface"
              role="option"
              aria-selected={selected(item)}
              disabled={disabled || !!item.error}
              tabIndex={item.path === focusablePath ? 0 : -1}
              data-directory={item.directory ?? settings.activeDir}
              data-tooltip={
                item.error ||
                (showAll
                  ? `${item.id}\n${gameDirectoryPath(item.directory ?? settings.activeDir)}`
                  : item.id)
              }
              onClick={() => onSelect(item)}
            >
              <PixelFrame />
              <ResourceImage path={versionIcon(item)} alt="" />
              <span className="launch-option-copy">
                <strong>{item.id}</strong>
                <small>
                  {item.loader === "Vanilla" ? "原版" : item.loader} · Java{" "}
                  {item.javaMajor}
                  {showAll && ` · ${directoryName(item)}`}
                </small>
                {item.error && (
                  <small className="launch-option-error">
                    版本不可用：{item.error}
                  </small>
                )}
              </span>
              {selected(item) && (
                <Check
                  size={17}
                  className="launch-option-check"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
      </div>
      {loading && (
        <div className="launch-picker-empty" role="status">
          <LoaderCircle className="spin" size={22} />
          <p>正在读取全部目录…</p>
        </div>
      )}
      {!loading && versions.length === 0 && (
        <div className="launch-picker-empty">
          {needle ? <Search size={26} /> : <Box size={26} />}
          <h3>{needle ? "没有找到这个版本" : "还没有本地游戏"}</h3>
          <p>
            {needle
              ? "换一个关键词，或安装一个新版本。"
              : "添加已有游戏目录，或安装一个全新的世界。"}
          </p>
          <Button disabled={disabled} onClick={onInstall}>
            <Plus size={15} />
            安装新版本
          </Button>
        </div>
      )}
    </div>
  );
}
