import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, bytes } from "../api";
import { Button, PixelFrame } from "../components";
import { usePageActive } from "../PageActivity";
import { ResourceSourceBadge, type ResourceSource } from "../resourceSources";
import { useApp } from "../store";
import { useTaskSelector } from "../tasks";
import type { LocalResource, ResourceInstallPlan, Version } from "../types";

type AvailableUpdate = {
  status: "available";
  token: string;
  source: ResourceSource;
  current: string;
  version: string;
  changelog: string;
};

const messages = {
  unidentified: "未识别到发布来源",
  latest: "已是最新兼容版本",
  noCompatibleRelease: "没有更新的兼容正式版",
};
type UpdateResult = AvailableUpdate | { status: keyof typeof messages };

function discard(token?: string | null) {
  if (token)
    void api("resources.discardInstallPlan", { token }).catch(() => {});
}

function changelogText(result: AvailableUpdate) {
  if (result.source !== "curseforge") return result.changelog;
  const template = document.createElement("template");
  template.innerHTML = result.changelog;
  template.content
    .querySelectorAll("script,style")
    .forEach((node) => node.remove());
  template.content
    .querySelectorAll("br,p,div,li")
    .forEach((node) => node.append("\n"));
  return template.content.textContent?.trim();
}

type InstallButtonProps = {
  label: string;
  cancelStage?: "plan" | "job";
  onClick?: () => void;
};

function InstallButton({ label, cancelStage, onClick }: InstallButtonProps) {
  const [readyStage, setReadyStage] =
    useState<InstallButtonProps["cancelStage"]>();
  useEffect(() => {
    setReadyStage(undefined);
    if (!cancelStage) return;
    const timer = window.setTimeout(() => setReadyStage(cancelStage), 1000);
    return () => window.clearTimeout(timer);
  }, [cancelStage]);

  const canCancel = !!onClick && !!cancelStage && readyStage === cancelStage;
  const enabled = !!onClick && (!cancelStage || canCancel);
  return (
    <Button
      primary
      className="local-mod-install-button"
      data-can-cancel={canCancel || undefined}
      aria-disabled={!enabled || undefined}
      onClick={enabled ? onClick : undefined}
    >
      <span className="local-mod-install-status" aria-hidden="true">
        <Download size={16} />
        {label}
      </span>
      {cancelStage && (
        <span className="local-mod-install-cancel" aria-hidden="true">
          <X size={16} />
          取消
        </span>
      )}
      <span className="sr-only">
        <span className="local-mod-install-status-name">{label}</span>
        {cancelStage && (
          <span className="local-mod-install-cancel-name">取消</span>
        )}
      </span>
    </Button>
  );
}

export function useLocalModUpdate(item: LocalResource, version: Version) {
  const { notify, reportError, clearError } = useApp();
  const pageActive = usePageActive();
  const visible = useRef(pageActive);
  useLayoutEffect(() => {
    visible.current = pageActive;
    return () => {
      visible.current = false;
    };
  }, [pageActive]);
  const target = { directory: version.directory, versionId: version.id };
  const [result, setResult] = useState<AvailableUpdate>();
  const [plan, setPlan] = useState<ResourceInstallPlan>();
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [dismissedJob, setDismissedJob] = useState("");
  const [cancellingJob, setCancellingJob] = useState("");
  const alive = useRef(false);
  const working = useRef<symbol | null>(null);
  const cancelOnStart = useRef(false);
  const planToken = useRef<string | null>(null);
  const job = useTaskSelector((tasks) =>
    tasks.jobs.find((j) =>
      jobId ? j.id === jobId : j.modUpdatePath === item.path,
    ),
  );
  const download = useTaskSelector((tasks) =>
    tasks.downloads.find((d) => d.id === job?.downloadId),
  );
  const retryDownload =
    job?.status === "failed" && !!job.downloadId && !job.error;
  const running =
    (jobId && !job) ||
    (job &&
      (!["completed", "failed", "cancelled"].includes(job.status) ||
        retryDownload));
  const locked = !!phase || !!running;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      discard(planToken.current);
    };
  }, []);

  function closePlan() {
    discard(planToken.current);
    planToken.current = null;
    setPlan(undefined);
  }

  async function run(
    phase: string,
    action: (request: symbol) => Promise<void>,
  ) {
    if (working.current) return;
    const request = Symbol(phase);
    working.current = request;
    setPhase(phase);
    setError("");
    try {
      await action(request);
    } catch (e) {
      if (!alive.current || working.current !== request) return;
      if (phase === "check") {
        if (visible.current) reportError(`检查失败，可重试。 ${String(e)}`);
      } else {
        setError(String(e));
      }
    } finally {
      if (working.current === request) {
        working.current = null;
        if (alive.current) setPhase("");
      }
    }
  }

  function check() {
    void run("check", async () => {
      clearError();
      closePlan();
      setResult(undefined);
      setDismissedJob(job?.id ?? "");
      setJobId("");
      const response = await api<UpdateResult>("resources.checkModUpdate", {
        ...target,
        path: item.path,
      });
      if (!alive.current) return;
      if (response.status === "available") setResult(response);
      else if (visible.current) notify(messages[response.status]);
    });
  }

  function preview(token: string) {
    void run("preview", async (request) => {
      closePlan();
      const next = await api<ResourceInstallPlan>("resources.modUpdatePlan", {
        ...target,
        token,
      });
      if (!alive.current || working.current !== request) {
        discard(next.token);
        return;
      }
      planToken.current = next.token;
      setPlan(next);
    });
  }

  function cancelPreview() {
    working.current = null;
    setPhase("");
    closePlan();
  }

  async function cancelJob(id: string) {
    await api("jobs.cancel", { id });
    if (alive.current) setCancellingJob(id);
  }

  function cancelInstall() {
    if (phase === "install") {
      // The start request has to return the new job ID before it can be cancelled.
      cancelOnStart.current = true;
      setPhase("cancel");
      return;
    }
    const id = jobId || job?.id;
    if (id) void run("cancel", () => cancelJob(id));
  }

  function install() {
    if (!plan?.token) return;
    const token = plan.token;
    void run("install", async () => {
      cancelOnStart.current = false;
      const enablePaths = plan.items
        .filter((i) => i.status === "disabled")
        .map((i) => i.path);
      planToken.current = null;
      setPlan(undefined);
      try {
        const id = await api<string>("resources.install", {
          ...target,
          token,
          enablePaths,
        });
        if (alive.current) {
          setJobId(id);
          setResult(undefined);
        }
        if (cancelOnStart.current) await cancelJob(id);
      } finally {
        discard(token);
      }
    });
  }

  const changes =
    plan?.items.filter((i) => !i.main && i.status !== "installed") ?? [];
  const canInstallPlan = !!plan?.token && !plan.issues.length;
  const jobMessage =
    job &&
    job.id !== dismissedJob &&
    (job.status === "completed"
      ? "模组更新完成"
      : job.status === "cancelled"
        ? "模组更新已取消"
        : retryDownload
          ? "下载失败，可重试"
          : job.error || job.steps[job.currentStep]?.detail || "正在更新模组…");
  let installAction: InstallButtonProps | undefined;
  if (phase === "cancel" || (running && cancellingJob === (jobId || job?.id))) {
    installAction = { label: "正在取消…" };
  } else if (running || phase === "install") {
    installAction = {
      label: retryDownload
        ? "下载失败"
        : (running && job?.steps[job.currentStep]?.name) || "正在准备安装…",
      cancelStage: "job",
      onClick: phase === "retry" ? undefined : cancelInstall,
    };
  } else if (phase === "preview" || plan) {
    installAction = {
      label: !plan ? "正在检查前置…" : canInstallPlan ? "等待确认" : "无法安装",
      cancelStage: "plan",
      onClick: cancelPreview,
    };
  } else if (result) {
    installAction = {
      label: "下载安装",
      onClick: () => preview(result.token),
    };
  }
  const button = (
    <Button disabled={locked} aria-busy={phase === "check"} onClick={check}>
      {phase === "check" ? (
        <LoaderCircle className="spin" size={16} />
      ) : (
        <RefreshCw size={16} />
      )}
      {phase === "check" ? "正在检查…" : "更新"}
    </Button>
  );
  const panel =
    result || running || jobMessage || error ? (
      <section
        className="local-mod-update has-surface"
        aria-label={result ? "可用模组更新" : "模组更新"}
      >
        <PixelFrame />
        {(installAction || jobMessage) && (
          <div className="local-mod-update-heading">
            <div className="local-mod-update-summary">
              {result && (
                <div className="local-mod-update-versions">
                  <strong>
                    {result.current} → {result.version}
                  </strong>
                  <ResourceSourceBadge source={result.source} />
                </div>
              )}
              {jobMessage && (
                <p role="status">
                  {jobMessage}
                  {download &&
                    ` · ${bytes(download.downloaded)}${download.total ? " / " + bytes(download.total) : ""}`}
                </p>
              )}
            </div>
            {installAction && (
              <div className="row-actions">
                {plan && (
                  <Button
                    primary
                    disabled={locked || !canInstallPlan}
                    onClick={install}
                  >
                    确认安装
                  </Button>
                )}
                <InstallButton {...installAction} />
              </div>
            )}
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {retryDownload && (
          <Button
            disabled={!!phase || cancellingJob === job?.id}
            onClick={() =>
              void run("retry", () =>
                api("downloads.control", {
                  id: job?.downloadId,
                  action: "retry",
                }),
              )
            }
          >
            重试下载
          </Button>
        )}
        {result && (
          <>
            <h3>更新日志</h3>
            <p className="local-mod-changelog">
              {changelogText(result) || "发布者未提供更新日志"}
            </p>
            {plan && (
              <>
                <h3>确认更新到 {result.version}</h3>
                {changes.length > 0 && (
                  <ul aria-label="必需前置">
                    {changes.map((i) => (
                      <li key={i.projectId}>
                        {i.status === "disabled"
                          ? "启用已有前置"
                          : "新增必需前置"}{" "}
                        · {i.name} {i.version}
                      </li>
                    ))}
                  </ul>
                )}
                {item.disabled && <p>更新后模组保持禁用。</p>}
                {plan.warnings.map((message) => (
                  <p key={message}>{message}</p>
                ))}
                {plan.issues.map((message) => (
                  <p key={message} role="alert" className="inline-error">
                    {message}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </section>
    ) : null;
  return { button, panel };
}
