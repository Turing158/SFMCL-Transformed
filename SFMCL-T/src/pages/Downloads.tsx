import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  FileText,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "../PageHeader";
import { AnimatedSwap } from "../AnimatedSwap";
import { useTabContentTransition } from "../useTabContentTransition";
import { useButtonPressFeedback } from "../useButtonPressFeedback";
import { useApp } from "../store";
import { api, bytes, confirmAction, pick, statusLabel } from "../api";
import {
  Badge,
  Button,
  Empty,
  Modal,
  Steps,
  TabList,
  TabPanel,
  PixelFrame,
} from "../components";
import type { Download, DownloadFile, Job, Status } from "../types";
import "../downloads.css";

function DownloadBadge({ status }: { status: Status }) {
  return (
    <Badge className={status}>
      <AnimatedSwap value={status}>{statusLabel[status]}</AnimatedSwap>
    </Badge>
  );
}

export function Downloads() {
  const app = useApp();
  const [filter, setFilter] = useState("all");
  const tabContent = useTabContentTransition(
    ["all", "active", "completed", "failed"].indexOf(filter),
  );
  const [fileId, setFileId] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const pressFeedback = useButtonPressFeedback("sfmcl-t-download-press");
  const active = app.tasks.downloads.filter((d) =>
    ["running", "paused", "pausing", "queued"].includes(d.status),
  );
  const failed = app.tasks.downloads.filter((d) => d.status === "failed");
  const speed = app.tasks.downloads.reduce((a, d) => a + d.speed, 0);
  const selectedJob = app.tasks.jobs.find((j) => j.id === log);
  const downloads = useMemo(
    () =>
      app.tasks.downloads.filter(
        (d) =>
          filter === "all" ||
          (filter === "active"
            ? ["running", "paused", "pausing", "queued"].includes(d.status)
            : d.status === filter),
      ),
    [app.tasks.downloads, filter],
  );
  return (
    <div className="downloads-page" onClickCapture={pressFeedback}>
      <PageHeader
        icon={<ArrowDownToLine />}
        eyebrow="EVERY BYTE COUNTS"
        title="下载中心"
      />
      <div className="stat-grid">
        <div className="panel stat has-surface">
          <PixelFrame />
          <span>
            <ArrowDownToLine size={19} />
            当前速度
          </span>
          <strong>
            {bytes(speed)}
            <small>/s</small>
          </strong>
        </div>
        <div className="panel stat has-surface">
          <PixelFrame />
          <span>
            <RefreshCw size={19} />
            进行中的任务
          </span>
          <strong>
            {active.length}
            <small>个</small>
          </strong>
        </div>
        <div className="panel stat has-surface">
          <PixelFrame />
          <span>
            <CheckCircle2 size={19} />
            需要处理
          </span>
          <strong>
            {failed.length}
            <small>个任务</small>
          </strong>
        </div>
      </div>
      {app.tasks.jobs.length > 0 && (
        <>
          <div className="section-heading">
            <h2>操作步骤</h2>
            <span>安装、启动与账号状态</span>
          </div>
          <div className="job-list">
            {app.tasks.jobs.slice(0, 12).map((job) => (
              <JobCard key={job.id} job={job} onLog={() => setLog(job.id)} />
            ))}
          </div>
        </>
      )}
      <div className="section-heading">
        <TabList
          id="downloads"
          label="下载任务筛选"
          value={filter}
          onValueChange={setFilter}
          items={[
            {
              value: "all",
              label: "全部任务",
              count: app.tasks.downloads.length,
            },
            { value: "active", label: "进行中", count: active.length },
            {
              value: "completed",
              label: "已完成",
              count: app.tasks.downloads.filter((d) => d.status === "completed")
                .length,
            },
            { value: "failed", label: "需要处理", count: failed.length },
          ]}
        />
        <span>{downloads.length} 个任务</span>
      </div>
      <TabPanel ref={tabContent} id="downloads" value={filter}>
        <DownloadList key={filter} downloads={downloads} onFiles={setFileId} />
      </TabPanel>
      {fileId && <FileDialog id={fileId} onClose={() => setFileId(null)} />}{" "}
      {selectedJob && (
        <Modal
          title={`${selectedJob.title} · 日志`}
          onClose={() => setLog(null)}
          wide
        >
          <DownloadBadge status={selectedJob.status} />
          <pre className="log-view">
            {selectedJob.log.join("\n") || "尚无进程输出。"}
          </pre>
          {selectedJob.error && (
            <p className="inline-error">{selectedJob.error}</p>
          )}
          <Button
            onClick={() =>
              void app.run(
                () => navigator.clipboard.writeText(selectedJob.log.join("\n")),
                "日志已复制",
              )
            }
          >
            复制日志
          </Button>
        </Modal>
      )}
    </div>
  );
}
function DownloadList({
  downloads,
  onFiles,
}: {
  downloads: Download[];
  onFiles: (id: string) => void;
}) {
  const app = useApp();
  const [display, setDisplay] = useState({
    source: downloads,
    items: downloads,
  });
  const ids = new Set(downloads.map((download) => download.id));
  let current = display;
  if (display.source !== downloads) {
    const items = [...downloads];
    // Retain removed cards in their old slots until their space has collapsed.
    // Live snapshots still update immediately during the exit animation.
    display.items.forEach((download, index) => {
      if (!ids.has(download.id)) items.splice(index, 0, download);
    });
    current = { source: downloads, items };
    setDisplay(current);
  }
  if (!current.items.length) {
    return (
      <section className="panel has-surface download-empty">
        <PixelFrame />
        <Empty
          title="这里暂时很安静"
          description="安装游戏或下载资源后，你可以在这里暂停、继续和查看进度。"
          action={
            <Button onClick={() => app.setPage("versions")}>
              去安装一个版本
            </Button>
          }
        />
      </section>
    );
  }
  return (
    <div className="download-list">
      {current.items.map((download) => (
        <DownloadRow
          key={download.id}
          download={download}
          exiting={!ids.has(download.id)}
          onFiles={() => onFiles(download.id)}
          onExited={() =>
            setDisplay((latest) =>
              latest.source.some((item) => item.id === download.id)
                ? latest
                : {
                    ...latest,
                    items: latest.items.filter(
                      (item) => item.id !== download.id,
                    ),
                  },
            )
          }
        />
      ))}
    </div>
  );
}

function DownloadRow({
  download,
  exiting,
  onFiles,
  onExited,
}: {
  download: Download;
  exiting: boolean;
  onFiles: () => void;
  onExited: () => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const finish = useRef(onExited);
  finish.current = onExited;
  useLayoutEffect(() => {
    const element = row.current;
    if (!exiting || !element) return;
    if (!element.offsetHeight) {
      finish.current();
      return;
    }
    const gap =
      parseFloat(getComputedStyle(element.parentElement!).rowGap) || 0;
    const easing = "cubic-bezier(0.22, 0.8, 0.25, 1)";
    const fade = element.firstElementChild!.animate(
      [
        { opacity: 1, transform: "translateX(0) scale(1)" },
        { opacity: 0, transform: "translateX(16px) scale(0.98)" },
      ],
      { id: "sfmcl-t-download-exit", duration: 180, easing, fill: "both" },
    );
    // Collapse the row and its gap together so siblings move continuously,
    // including when multiple removals overlap or the page is scrolled.
    const collapse = element.animate(
      [
        {
          height: `${element.getBoundingClientRect().height}px`,
          marginBottom: "0px",
        },
        { height: "0px", marginBottom: `${-gap}px` },
      ],
      { id: "sfmcl-t-download-collapse", duration: 280, easing, fill: "both" },
    );
    void collapse.finished.then(
      () => finish.current(),
      () => {},
    );
    return () => {
      fade.cancel();
      collapse.cancel();
    };
  }, [exiting]);
  return (
    <div
      ref={row}
      className="download-row"
      data-download-id={download.id}
      data-exiting={exiting}
      inert={exiting}
      aria-hidden={exiting}
    >
      <DownloadCard download={download} onFiles={onFiles} />
    </div>
  );
}

function JobCard({ job, onLog }: { job: Job; onLog: () => void }) {
  const app = useApp();
  const [open, setOpen] = useState(job.status !== "completed");
  const id = useId();
  return (
    <article className="panel job-card has-surface" data-open={open}>
      <PixelFrame />
      <div className="job-header">
        <button
          type="button"
          className="job-toggle"
          id={`${id}-toggle`}
          aria-expanded={open}
          aria-controls={`${id}-steps`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="job-chevron" aria-hidden="true">
            <ChevronDown size={17} />
          </span>
          <strong>{job.title}</strong>
        </button>
        <DownloadBadge status={job.status} />
        <div className="row-actions">
          <button
            className="icon-button has-surface"
            aria-label={`查看 ${job.title} 日志`}
            onClick={onLog}
          >
            <PixelFrame />
            <FileText size={17} />
          </button>
          {job.status !== "completed" && job.status !== "cancelled" && (
            <button
              className="icon-button has-surface"
              aria-label={`取消 ${job.title}`}
              onClick={() =>
                void app.run(() => api("jobs.cancel", { id: job.id }))
              }
            >
              <PixelFrame />
              <X size={17} />
            </button>
          )}
        </div>
      </div>
      <div
        className="job-body"
        id={`${id}-steps`}
        role="region"
        aria-labelledby={`${id}-toggle`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="job-body-clip">
          <Steps steps={job.steps} animated />
          {job.error && <p className="inline-error">{job.error}</p>}
          {job.status === "failed" && job.downloadId && (
            <p className="helper">
              文件下载失败。重试下方下载任务后，安装将自动继续。
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
function DownloadCard({
  download: d,
  onFiles,
}: {
  download: Download;
  onFiles: () => void;
}) {
  const app = useApp();
  const progress =
    d.status === "completed"
      ? 1
      : d.total > 0
        ? Math.min(1, d.downloaded / d.total)
        : d.fileCount
          ? d.completed / d.fileCount
          : 0;
  const control = (action: string) =>
    void app.run(() => api("downloads.control", { id: d.id, action }));
  const clearing = app.clearingDownloads.has(d.id);
  return (
    <article className="panel download-card has-surface">
      <PixelFrame />
      <div className="download-header">
        <span className="download-icon has-surface">
          <PixelFrame />
          <ArrowDownToLine size={21} />
        </span>
        <div>
          <h3>{d.title}</h3>
          <p>
            {d.completed.toLocaleString()} / {d.fileCount.toLocaleString()}{" "}
            个文件 · {d.workers} 个工作线程
            {d.failed > 0 && ` · ${d.failed} 个失败`}
          </p>
        </div>
        <DownloadBadge status={d.status} />
        <div className="row-actions">
          {d.status === "running" && (
            <button
              className="icon-button has-surface"
              aria-label={`暂停 ${d.title}`}
              disabled={clearing}
              onClick={() => control("pause")}
            >
              <PixelFrame />
              <Pause size={17} />
            </button>
          )}
          {d.status === "pausing" && (
            <span className="helper">等待写入停止…</span>
          )}
          {["paused", "failed"].includes(d.status) && (
            <button
              className="icon-button has-surface"
              aria-label={`继续 ${d.title}`}
              disabled={clearing}
              onClick={() => control("resume")}
            >
              <PixelFrame />
              <Play size={17} />
            </button>
          )}
          {!["completed", "cancelled", "pausing"].includes(d.status) && (
            <button
              className="icon-button has-surface"
              aria-label={`取消 ${d.title}`}
              disabled={clearing}
              onClick={async () => {
                if (await confirmAction("取消此下载任务？已完成的文件会保留。"))
                  await app.run(() =>
                    api("downloads.control", {
                      id: d.id,
                      action: "cancel",
                    }),
                  );
              }}
            >
              <PixelFrame />
              <X size={17} />
            </button>
          )}
          {["completed", "cancelled", "failed"].includes(d.status) && (
            <button
              className="icon-button has-surface"
              aria-label={`清理 ${d.title}`}
              disabled={clearing}
              aria-busy={clearing}
              onClick={() => void app.clearDownload(d.id)}
            >
              <PixelFrame />
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </div>
      <div
        className={`progress ${d.status}`}
        role="progressbar"
        aria-label={`${d.title} 进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="download-bottom">
        <span>
          {bytes(d.downloaded)} /{" "}
          {d.unknownSize ? "部分大小未知" : bytes(d.total)}
        </span>
        <span>
          {d.status === "running"
            ? `${bytes(d.speed)}/s`
            : `${Math.round(progress * 100)}%`}
        </span>
        <button onClick={onFiles}>
          查看文件 <ChevronDown size={14} />
        </button>
      </div>
      {d.error && <p className="inline-error">{d.error}</p>}
    </article>
  );
}
function FileDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const app = useApp();
  const [result, setResult] = useState<{
    offset: number;
    files: DownloadFile[];
  } | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const download = app.tasks.downloads.find((d) => d.id === id);
  const packDownload = app.tasks.jobs.some(
    (job) =>
      job.downloadId === id &&
      job.title.startsWith("安装整合包 ") &&
      !["completed", "cancelled"].includes(job.status),
  );
  const total = download?.fileCount || 0;
  const pageOffset = Math.min(
    offset,
    Math.max(0, Math.ceil(total / 100) - 1) * 100,
  );
  const files = result?.offset === pageOffset ? result.files : [];
  const loading = result?.offset !== pageOffset && !error;
  function changePage(next: number) {
    setError("");
    setOffset(next);
    content.current?.closest(".modal-body")?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await api<DownloadFile[]>("downloads.files", {
          id,
          offset: pageOffset,
        });
        if (active) {
          setResult({ offset: pageOffset, files: rows });
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, pageOffset]);
  return (
    <Modal
      title="文件下载详情"
      onClose={onClose}
      wide
      className="download-files-dialog"
    >
      <div className="download-file-content" ref={content}>
        {error && <p className="inline-error">{error}</p>}
        <div className="file-table" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>文件</th>
                <th>状态</th>
                <th>大小 / 进度</th>
                <th>尝试</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} className="file-placeholder" role="status">
                    正在加载文件…
                  </td>
                </tr>
              )}
              {!loading && !files.length && (
                <tr>
                  <td colSpan={4} className="file-placeholder">
                    {error ? "暂时无法读取文件，将自动重试。" : "暂无文件"}
                  </td>
                </tr>
              )}
              {files.map((f) => (
                <tr key={f.spec.path}>
                  <td>
                    <span className="path-text">{f.spec.path}</span>
                    {f.error && (
                      <small className="danger-text">{f.error}</small>
                    )}
                    {packDownload &&
                      f.status === "failed" &&
                      (f.spec.sha1 || f.spec.sha512) && (
                        <Button
                          disabled={app.busy}
                          onClick={() =>
                            void app.run(async () => {
                              const source = await pick(false, undefined, {
                                title: `选择 ${f.spec.path.split(/[\\/]/).pop()} 的原始文件`,
                              });
                              if (source)
                                await api("modpacks.supplyFile", {
                                  id,
                                  path: f.spec.path,
                                  source,
                                });
                            })
                          }
                        >
                          补选已下载文件
                        </Button>
                      )}
                  </td>
                  <td>
                    <DownloadBadge status={f.status} />
                  </td>
                  <td>
                    {bytes(f.downloaded)} / {f.total ? bytes(f.total) : "未知"}
                  </td>
                  <td>{f.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <nav
          className="pagination download-file-pagination"
          aria-label="文件下载分页"
        >
          <Button
            disabled={loading || pageOffset === 0}
            onClick={() => changePage(Math.max(0, pageOffset - 100))}
          >
            上一页
          </Button>
          <span className="page-indicator has-surface" tabIndex={0}>
            <PixelFrame />
            <span className="page-indicator-text">
              {loading
                ? "正在加载…"
                : `${files.length ? pageOffset + 1 : 0}–${files.length ? pageOffset + files.length : 0} / ${total}`}
            </span>
          </span>
          <Button
            disabled={loading || pageOffset + 100 >= total}
            onClick={() => changePage(pageOffset + 100)}
          >
            下一页
          </Button>
        </nav>
      </div>
    </Modal>
  );
}
