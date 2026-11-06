import { useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { api, bytes, confirmAction, pick, saveFile } from "./api";
import { flushAutoSaves } from "./autoSave";
import { Button, PixelFrame } from "./components";
import { Input } from "./controls";
import { useApp } from "./store";
import type { LocalDataOperation } from "./types";

interface PreparedOperation {
  id: string;
  kind: LocalDataOperation;
  path: string;
  backup?: { createdAt: number; fileCount: number; totalBytes: number };
}

const names = { migrate: "更改路径", backup: "备份数据", restore: "还原数据" };

export function LocalDataSettings() {
  const app = useApp();
  const [working, setWorking] = useState<LocalDataOperation | null>(null);
  const [restarting, setRestarting] = useState(false);
  const inFlight = useRef(false);
  const result = app.data.localDataResult;
  const activeTasks =
    app.tasks.downloads.some((download) =>
      ["queued", "running", "pausing"].includes(download.status),
    ) ||
    app.tasks.jobs.some(
      (job) => !["completed", "failed", "cancelled"].includes(job.status),
    );
  const unavailable = app.busy || !!working || restarting || !app.data.dataDir;
  const disabled = unavailable || activeTasks;

  const operate = async (kind: LocalDataOperation) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(kind);
    let started = false;
    try {
      await app.run(async () => {
        const path =
          kind === "backup"
            ? await saveFile({
                title: "备份本地数据",
                defaultPath: `SFMCL-T-data-${new Date().toLocaleString("sv-SE").replace(/[ :]/g, "-")}.zip`,
                filterName: "SFMCL-T 本地数据备份",
                extensions: ["zip"],
              })
            : await pick(
                kind === "migrate",
                kind === "restore" ? ["zip"] : undefined,
                {
                  title:
                    kind === "migrate"
                      ? "选择新的本地数据文件夹（空文件夹）"
                      : "选择本地数据备份",
                  filterName: "SFMCL-T 本地数据备份",
                },
              );
        if (!path) return;
        if (!(await flushAutoSaves()))
          throw new Error("设置尚未保存，请稍后再操作本地数据。");
        const operation = await api<PreparedOperation>("local-data.prepare", {
          kind,
          path,
        });
        const message =
          kind === "migrate"
            ? `将本地数据迁移到「${operation.path}」？全部文件校验完成后才会启用新路径并清理旧目录，随后自动重新打开启动器。`
            : kind === "backup"
              ? `将当前本地数据备份到「${operation.path}」？为完整备份设置、角色及正在使用的数据文件，启动器会自动关闭，备份完成后重新打开。`
              : `从「${operation.path}」还原本地数据？${operation.backup ? `此备份创建于 ${new Date(operation.backup.createdAt * 1000).toLocaleString()}，包含 ${operation.backup.fileCount} 个文件（${bytes(operation.backup.totalBytes)}）。` : ""}当前数据会先保留为副本，然后替换为备份中的数据并自动重新打开启动器。`;
        if (!(await confirmAction(message))) return;
        if (!(await flushAutoSaves()))
          throw new Error("设置尚未保存，本地数据操作未开始。");
        await api("local-data.execute", { id: operation.id });
        started = true;
        setRestarting(true);
      });
    } finally {
      if (!started) {
        inFlight.current = false;
        setWorking(null);
      }
    }
  };

  return (
    <section
      className="panel settings-section local-data-settings has-surface"
      aria-labelledby="local-data-title"
      aria-busy={!!working}
    >
      <PixelFrame />
      <h2 id="local-data-title">本地数据</h2>
      {activeTasks && (
        <p className="local-data-progress" role="status">
          请先结束正在运行的游戏、下载、安装或登录任务。
        </p>
      )}
      <div className="field">
        <label htmlFor="local-data-directory">数据文件夹</label>
        <div className="input-action local-data-directory-actions">
          <Input
            id="local-data-directory"
            value={app.data.dataDir}
            readOnly
            title={app.data.dataDir}
            placeholder="在桌面应用中查看配置目录"
          />
          <Button disabled={disabled} onClick={() => void operate("migrate")}>
            {working === "migrate" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <FolderInput size={16} />
            )}
            更改路径
          </Button>
          <button
            type="button"
            className="icon-button has-surface local-data-open"
            aria-label="打开本地数据文件夹"
            data-tooltip="打开本地数据文件夹"
            disabled={unavailable}
            onClick={() =>
              void app.run(() => api("path.open", { path: app.data.dataDir }))
            }
          >
            <PixelFrame />
            <FolderOpen size={17} />
          </button>
        </div>
      </div>
      <div className="row-actions local-data-backup-actions">
        <Button disabled={disabled} onClick={() => void operate("backup")}>
          {working === "backup" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Archive size={16} />
          )}
          备份数据
        </Button>
        <Button disabled={disabled} onClick={() => void operate("restore")}>
          {working === "restore" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArchiveRestore size={16} />
          )}
          还原数据
        </Button>
      </div>
      {working && (
        <p className="local-data-progress" role="status">
          {restarting
            ? `${names[working]}已开始，完成后自动重新打开启动器…`
            : `正在准备${names[working]}…`}
        </p>
      )}
      {result && (
        <div
          className="local-data-result"
          data-success={result.success}
          role={result.success ? "status" : "alert"}
        >
          <strong>{result.message}</strong>
          {result.success && result.kind === "backup" && (
            <p className="path-text">备份文件：{result.path}</p>
          )}
          {result.recoveryPath && (
            <div className="local-data-recovery">
              <p className="path-text">原数据副本：{result.recoveryPath}</p>
              <button
                type="button"
                className="icon-button has-surface"
                aria-label="打开原数据副本"
                data-tooltip="打开原数据副本"
                disabled={unavailable}
                onClick={() =>
                  void app.run(() => api("local-data.recovery.open"))
                }
              >
                <PixelFrame />
                <FolderOpen size={17} />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
