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
  RefObject,
} from "react";
import {
  Box,
  Check,
  CheckCircle2,
  ChevronUp,
  CircleAlert,
  FolderOpen,
  Info,
  LoaderCircle,
  Play,
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
import { useApp } from "./store";
import { FooterText } from "./FooterText";
import { FooterStatusIcon } from "./FooterStatusIcon";
import type { Tasks, Version } from "./types";
import "./launch-dock.css";

type PendingAction = {
  kind: "launch" | "cancel" | "resume";
  jobId?: string;
  requested: boolean;
  snapshot: Tasks;
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

export function LaunchDock({ playerCaption }: { playerCaption: string }) {
  const app = useApp();
  const settings = app.data.settings;
  const task = getLaunchTask(app.tasks, settings.activeVersion);
  const version = app.versions.find((item) => item.id === task.versionId);
  const player = app.data.players.find(
    (item) => item.uuid === settings.activePlayer,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<{
    context: string;
    message: string;
  } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const dock = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const requestInFlight = useRef(false);
  const focusWhenReady = useRef(false);
  const tasksRef = useRef(app.tasks);
  tasksRef.current = app.tasks;
  const pickerId = useId();
  const statusId = useId();
  const context = `${settings.activeDir}\n${settings.activeVersion}\n${settings.activePlayer}`;
  const localError =
    actionError?.context === context ? actionError.message : "";
  const locked = task.active || !!pending;

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
    if (focusWhenReady.current && !pickerOpen && !app.busy && !selecting) {
      focusWhenReady.current = false;
      actions.current
        ?.querySelector<HTMLButtonElement>(".launch-switch")
        ?.focus({ preventScroll: true });
    }
  }, [pickerOpen, app.busy, selecting]);

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
    if (!pending?.requested || !pending.jobId) return;
    const job = app.tasks.jobs.find((item) => item.id === pending.jobId);
    if (!job) return;
    const settled =
      pending.kind === "launch" ||
      (pending.kind === "cancel" &&
        !isActiveLaunch(job, app.tasks.downloads)) ||
      (pending.kind === "resume" && app.tasks !== pending.snapshot);
    if (settled) setPending(null);
  }, [app.tasks, pending]);

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
  const statusKind = failure
    ? "error"
    : spinning
      ? "busy"
      : warning
        ? "warning"
        : "ready";
  const StatusIcon = {
    error: CircleAlert,
    busy: LoaderCircle,
    warning: Info,
    ready: CheckCircle2,
  }[statusKind];
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
              : Play;
  const primaryText =
    mode === "running"
      ? "结束游戏"
      : mode === "cancelling"
        ? "正在结束"
        : mode === "preparing"
          ? "正在启动"
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
    setPending({ kind, jobId, requested: false, snapshot: app.tasks });
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

  const canCancel = locked && mode !== "running";
  const showPicker = () => {
    if (locked || app.busy || requestInFlight.current) return;
    if (localError) app.clearError();
    setSelectionError("");
    setPickerOpen((open) => !open);
  };
  const selectVersion = async (item: Version) => {
    if (locked || app.busy || requestInFlight.current || item.error) return;
    if (item.id === settings.activeVersion) {
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
          await app.update("versions.select", { id: item.id });
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
      data-state={mode}
      data-error={failure || undefined}
      data-warning={warning || undefined}
    >
      {locked && mode !== "running" && (
        <div
          className={`launch-progress ${pending && !task.active ? "indeterminate" : ""}`}
          role="progressbar"
          aria-label="游戏启动步骤进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pending && !task.active ? undefined : task.progress}
          aria-valuetext={message}
          style={
            { "--launch-progress": (task.progress || 0) / 100 } as CSSProperties
          }
        >
          <span />
        </div>
      )}
      <div className="launch-dock-main">
        <div className="launch-version">
          <ResourceImage
            path={versionIcon(version)}
            alt={version?.loader || "Minecraft"}
          />
          <div className="launch-version-copy">
            {task.active && (
              <span className="overline">
                {mode === "running" ? "正在运行的版本" : "正在启动的版本"}
              </span>
            )}
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
                <Badge className="launch-java">Java {version.javaMajor}</Badge>
              </div>
            ) : (
              <p>
                {task.active
                  ? "在下载中心查看这次游戏的进度与日志"
                  : "添加已有游戏，或安装一个全新的世界。"}
              </p>
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
              if (mode === "running") app.setPage("downloads");
              else if (canCancel) void request("cancel");
              else showPicker();
            }}
          >
            {mode === "running"
              ? "查看日志"
              : canCancel
                ? "取消启动"
                : version
                  ? "切换版本"
                  : "选择版本"}
            {canCancel ? (
              <X size={16} />
            ) : mode === "running" ? (
              <FolderOpen size={16} />
            ) : (
              <ChevronUp size={16} />
            )}
          </LaunchButton>
          <LaunchButton
            primary
            className="launch-primary"
            aria-describedby={statusId}
            aria-busy={spinning}
            disabled={busy || mode === "empty" || spinning}
            onClick={primaryAction}
          >
            <PrimaryIcon
              size={17}
              className={spinning ? "spin" : undefined}
              fill={PrimaryIcon === Play ? "currentColor" : "none"}
            />
            {primaryText}
          </LaunchButton>
        </div>
      </div>
      <div className="launch-status">
        <div className="launch-status-detail">
          <FooterStatusIcon iconKey={statusKind}>
            <StatusIcon size={12} className={spinning ? "spin" : undefined} />
          </FooterStatusIcon>
          <FooterText
            slot="message"
            text={message}
            id={statusId}
            className="launch-status-message"
            role="status"
            data-tooltip={message}
          />
          {task.stepLabel && (
            <FooterText
              slot="step"
              text={task.stepLabel}
              className="launch-status-caption"
            />
          )}
        </div>
        {player && (
          <span className="launch-status-player" data-tooltip={playerCaption}>
            <UserRound size={12} aria-hidden="true" />
            <FooterText slot="player" text={playerCaption} />
          </span>
        )}
      </div>
      {pickerOpen && (
        <VersionPicker
          id={pickerId}
          actions={actions}
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
  disabled,
  error,
  onClose,
  onSelect,
  onInstall,
}: {
  id: string;
  actions: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  error: string;
  onClose: (restoreFocus?: boolean) => void;
  onSelect: (version: Version) => void;
  onInstall: () => void;
}) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const footerFeedback = useRef<Animation | null>(null);
  const needle = query.trim().toLowerCase();
  const versions = app.versions.filter((item) =>
    `${item.id} ${item.version} ${item.loader === "Vanilla" ? "原版 Vanilla" : item.loader} Java ${item.javaMajor}`
      .toLowerCase()
      .includes(needle),
  );
  const focusableId =
    versions.find(
      (item) => !item.error && item.id === app.data.settings.activeVersion,
    )?.id || versions.find((item) => !item.error)?.id;

  useLayoutEffect(() => {
    panel.current
      ?.querySelector<HTMLInputElement>("input")
      ?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => footerFeedback.current?.cancel(), []);

  function activateFooter(button: HTMLButtonElement, action: () => void) {
    if (footerFeedback.current) return;
    // Finish the short press before navigation unmounts the picker.
    const animation = button.animate(
      [
        { transform: "translateY(0)", easing: "steps(2, end)" },
        {
          transform: "translateY(2px)",
          offset: 1 / 3,
          easing: "steps(2, end)",
        },
        { transform: "translateY(0)" },
      ],
      { duration: 180 },
    );
    footerFeedback.current = animation;
    animation.onfinish = () => {
      footerFeedback.current = null;
      action();
    };
  }

  useEffect(() => {
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
  }, [actions, onClose]);

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
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      onKeyDown={keyboard}
    >
      <PixelFrame />
      <header className="launch-picker-heading">
        <div>
          <h2 id={`${id}-title`}>选择游戏版本</h2>
          <p>{app.versions.length} 个版本</p>
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
      <div
        className="launch-version-list"
        role="listbox"
        aria-label="本地游戏版本"
        aria-busy={disabled}
      >
        {versions.map((item) => (
          <button
            key={item.id}
            type="button"
            className="launch-version-option has-surface"
            role="option"
            aria-selected={item.id === app.data.settings.activeVersion}
            disabled={disabled || !!item.error}
            tabIndex={item.id === focusableId ? 0 : -1}
            data-tooltip={item.error || item.id}
            onClick={() => onSelect(item)}
          >
            <PixelFrame />
            <ResourceImage path={versionIcon(item)} alt="" />
            <span className="launch-option-copy">
              <strong>{item.id}</strong>
              <small>
                {item.loader === "Vanilla" ? "原版" : item.loader} · Java{" "}
                {item.javaMajor}
              </small>
              {item.error && (
                <small className="launch-option-error">
                  版本不可用：{item.error}
                </small>
              )}
            </span>
            {item.id === app.data.settings.activeVersion && (
              <Check
                size={17}
                className="launch-option-check"
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
      {versions.length === 0 && (
        <div className="launch-picker-empty">
          {needle ? <Search size={26} /> : <Box size={26} />}
          <h3>{needle ? "没有找到这个版本" : "还没有本地游戏"}</h3>
          <p>
            {needle
              ? "换一个关键词，或安装一个新版本。"
              : "添加已有游戏目录，或安装一个全新的世界。"}
          </p>
        </div>
      )}
      <div className="launch-picker-footer">
        <Button
          disabled={disabled}
          onClick={(event) =>
            activateFooter(event.currentTarget, () => {
              onClose(false);
              app.setPage("versions");
            })
          }
        >
          <FolderOpen size={15} />
          {app.versions.length ? "版本管理" : "添加已有游戏"}
        </Button>
        <Button
          disabled={disabled}
          onClick={(event) => activateFooter(event.currentTarget, onInstall)}
        >
          <Plus size={15} />
          安装新版本
        </Button>
      </div>
    </div>
  );
}
