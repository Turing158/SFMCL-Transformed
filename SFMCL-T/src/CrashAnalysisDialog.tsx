import { useEffect, useId, useState } from "react";
import { FolderOpen, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { Button, ErrorBanner, Modal } from "./components";
import { useTasks } from "./tasks";
import { useApp } from "./store";
import { useSessionState } from "./windowSession";
import type { Job } from "./types";
import "./crash-analysis.css";

export function CrashAnalysisDialog({
  job,
  onClose,
}: {
  job: Job;
  onClose: () => void;
}) {
  const descriptionId = useId();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const report = job.crashReport!;
  async function openLog() {
    if (opening) return;
    setOpening(true);
    setError("");
    try {
      await api("crash.openLog", { id: job.id });
    } catch (error) {
      setError(String(error));
    } finally {
      setOpening(false);
    }
  }
  return (
    <Modal
      title="崩溃原因分析"
      className="crash-analysis-dialog"
      descriptionId={descriptionId}
      showError={false}
      onClose={onClose}
    >
      {(requestClose) => (
        <>
          <div className="crash-analysis-status">
            <TriangleAlert size={16} aria-hidden="true" />
            {report.exitCode == null ? "启动未完成" : "游戏异常退出"}
          </div>
          <div className="crash-analysis-summary">
            <h3>{report.title}</h3>
            <p id={descriptionId}>{report.description}</p>
          </div>
          <div className="crash-analysis-meta">
            <span>{job.launch?.versionId || job.title}</span>
            {job.launch?.gameVersion &&
              job.launch.gameVersion !== job.launch.versionId && (
                <span>Minecraft {job.launch.gameVersion}</span>
              )}
            {report.exitCode != null && <span>退出代码 {report.exitCode}</span>}
          </div>
          <section className="crash-analysis-guidance" aria-label="建议处理">
            <h4>建议处理</h4>
            {report.suggestions.map((suggestion, index) => (
              <p key={index}>{suggestion}</p>
            ))}
          </section>
          <ErrorBanner message={error} />
          <div className="dialog-actions">
            <Button disabled={opening} onClick={() => void openLog()}>
              <FolderOpen size={16} aria-hidden="true" />
              {opening ? "正在打开…" : "前往日志所在位置"}
            </Button>
            <Button primary data-modal-autofocus onClick={requestClose}>
              确认
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function CrashAnalysisDialogHost() {
  const { jobs } = useTasks();
  const app = useApp();
  const [dismissed, setDismissed] = useSessionState<string[]>(
    "CrashAnalysis.dismissed",
    [],
  );
  const [active, setActive] = useState<Job | null>(null);
  const [blocked, setBlocked] = useState(
    () => !!document.querySelector("dialog[open]"),
  );
  useEffect(() => {
    const update = () => setBlocked(!!document.querySelector("dialog[open]"));
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (active || blocked) return;
    const next = jobs.find(
      (job) =>
        job.status === "failed" &&
        job.crashReport &&
        !job.crashReport.acknowledged &&
        !dismissed.includes(job.id),
    );
    if (next) setActive(next);
  }, [jobs, dismissed, active, blocked]);
  if (!active) return null;
  return (
    <CrashAnalysisDialog
      key={active.id}
      job={active}
      onClose={() => {
        setDismissed((current) => [...current, active.id]);
        setActive(null);
        void api("crash.acknowledge", { id: active.id }).catch((error) =>
          app.reportError(String(error)),
        );
      }}
    />
  );
}
