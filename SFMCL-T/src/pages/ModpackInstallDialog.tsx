import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen, LoaderCircle, Package } from "lucide-react";
import { api, pick } from "../api";
import { Button, Modal, TabList, TabPanel } from "../components";
import { Checkbox, Input, Select } from "../controls";
import { gameDirectoryPath } from "../gameDirectories";
import {
  modpackName,
  modpackNameError,
  type ModpackInspection,
  type ModpackSource,
} from "../modpacks";
import { useApp } from "../store";
import type { ResourceFile } from "../types";

export function ModpackInstallDialog({
  resource,
  initialSource,
  title = "整合包",
  queued = [],
  onQueued,
  onClose,
}: {
  resource?: ResourceFile;
  initialSource?: ModpackSource;
  title?: string;
  queued?: string[];
  onQueued?: (key: string) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const settings = app.data.settings;
  const [mode, setMode] = useState("install");
  const [root, setRoot] = useState(
    settings.activeDir || settings.gameDirs[0]?.path || "",
  );
  const [name, setName] = useState(
    modpackName(
      initialSource?.inspection.name ?? title,
      initialSource?.inspection.version ?? resource?.version,
    ),
  );
  const [path, setPath] = useState(initialSource?.path ?? "");
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<ModpackInspection | null>(
    initialSource?.inspection ?? null,
  );
  const [includeOptional, setIncludeOptional] = useState(false);
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const token = useRef<string | null>(initialSource?.inspection.token ?? null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode immediately remounts effects; only release a real unmount.
      queueMicrotask(() => {
        if (!mounted.current && token.current) {
          void api("modpacks.discard", { token: token.current }).catch(
            () => {},
          );
          token.current = null;
        }
      });
    };
  }, []);
  useEffect(() => {
    if (closing && !app.busy) onClose();
  }, [closing, app.busy, onClose]);
  const nameError = modpackNameError(name);
  const existing =
    root === settings.activeDir &&
    app.versions.some(
      (version) => version.id.toLowerCase() === name.toLowerCase(),
    );
  const key = JSON.stringify([
    resource?.id,
    mode,
    mode === "install" ? [root, name] : directory,
  ]);
  const alreadyQueued = queued.includes(key);
  const canSubmit =
    !app.busy &&
    !loading &&
    !alreadyQueued &&
    (mode === "folder"
      ? !!directory && !!resource?.file
      : !!root &&
        !nameError &&
        !existing &&
        (!!resource?.file || !!inspection));
  async function choose(directory: boolean) {
    const selected = await pick(
      directory,
      directory
        ? undefined
        : ["mrpack", "zip", "7z", "rar", "tar", "gz", "tgz"],
      {
        title: directory ? "选择整合包客户端目录" : "选择整合包压缩文件",
        filterName: "整合包",
      },
    );
    if (!selected) return;
    setLoading(true);
    try {
      const next = await api<ModpackInspection>("modpacks.inspect", {
        path: selected,
      });
      if (!mounted.current) {
        await api("modpacks.discard", { token: next.token });
        return;
      }
      if (token.current)
        await api("modpacks.discard", { token: token.current });
      token.current = next.token;
      setInspection(next);
      setPath(selected);
      setName(modpackName(next.name, next.version));
      setIncludeOptional(false);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <Modal
      title={resource ? `下载 ${title}` : "导入整合包"}
      onClose={onClose}
      closeDisabled={app.busy}
      className="modpack-install-dialog"
    >
      <form
        className="resource-download-form modpack-install-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          void app.run(async () => {
            if (mode === "folder") {
              await api("resources.download", {
                kind: "modpack",
                directory,
                file: resource?.file,
                title,
              });
              app.notify("整合包已加入下载队列");
            } else {
              await api("modpacks.install", {
                root,
                name,
                includeOptional,
                ...(resource
                  ? { file: resource.file }
                  : { token: inspection?.token }),
              });
              token.current = null;
              app.notify("整合包安装已开始，可在下载中心查看进度");
            }
            onQueued?.(key);
            setClosing(true);
          });
        }}
      >
        <div className="modpack-install-content">
          {resource ? (
            <p className="resource-download-name">{resource.file?.path}</p>
          ) : (
            <div className="modpack-source">
              <p
                className="modpack-source-path"
                data-selected={!!path || undefined}
                aria-label="整合包文件"
                data-tooltip={path || undefined}
              >
                {path || "选择压缩包或客户端目录"}
              </p>
              <div className="modpack-source-actions">
                <Button
                  disabled={app.busy}
                  onClick={() => void app.run(() => choose(false))}
                >
                  <Package size={16} />
                  选择压缩包
                </Button>
                <Button
                  disabled={app.busy}
                  onClick={() => void app.run(() => choose(true))}
                >
                  <FolderOpen size={16} />
                  选择客户端目录
                </Button>
                {loading && (
                  <span role="status">
                    <LoaderCircle className="spin" size={16} />
                    正在识别整合包…
                  </span>
                )}
              </div>
              <p className="helper">
                支持 MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ。
              </p>
            </div>
          )}
          {inspection && (
            <dl className="modpack-summary">
              <div>
                <dt>整合包格式</dt>
                <dd>{inspection.format}</dd>
              </div>
              <div>
                <dt>Minecraft</dt>
                <dd>{inspection.minecraft}</dd>
              </div>
              <div>
                <dt>加载器</dt>
                <dd>
                  {inspection.loader
                    ? `${inspection.loader.kind} ${inspection.loader.version}`
                    : "Minecraft"}
                </dd>
              </div>
              <div>
                <dt>清单文件</dt>
                <dd>{inspection.fileCount} 个</dd>
              </div>
            </dl>
          )}
          {resource && (
            <TabList
              id="modpack-download"
              label="下载方式"
              value={mode}
              onValueChange={setMode}
              items={[
                {
                  value: "install",
                  label: "安装新实例",
                  icon: <Package size={16} />,
                },
                {
                  value: "folder",
                  label: "下载到文件夹",
                  icon: <FolderOpen size={16} />,
                },
              ]}
            />
          )}
          <TabPanel
            id="modpack-download"
            value={mode}
            aria-label={
              mode === "install" ? "整合包安装设置" : "整合包下载文件夹"
            }
            aria-labelledby={
              resource ? `modpack-download-tab-${mode}` : undefined
            }
          >
            {mode === "install" ? (
              <div className="modpack-settings">
                <label>
                  游戏名称
                  <Input
                    aria-label="整合包游戏名称"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={app.busy}
                  />
                </label>
                {(nameError || existing) && (
                  <p className="helper" role="status">
                    {nameError || "此名称已存在，请使用其他名称。"}
                  </p>
                )}
                <label>
                  安装目录
                  <Select
                    aria-label="整合包安装目录"
                    value={root}
                    onValueChange={setRoot}
                    disabled={app.busy || !settings.gameDirs.length}
                  >
                    {!settings.gameDirs.length && (
                      <option value="">请先在版本管理中添加游戏目录</option>
                    )}
                    {settings.gameDirs.map((entry) => (
                      <option key={entry.path} value={entry.path}>
                        {entry.name} · {gameDirectoryPath(entry.path)}
                      </option>
                    ))}
                  </Select>
                </label>
                <p className="helper">
                  自动安装包内指定的 Minecraft
                  与加载器，并启用独立游戏目录。安装进度、重试和取消可在下载中心操作。
                </p>
                {(resource || !!inspection?.optionalFiles.length) && (
                  <>
                    <label className="modpack-optional">
                      <Checkbox
                        checked={includeOptional}
                        onChange={(event) =>
                          setIncludeOptional(event.target.checked)
                        }
                        disabled={app.busy}
                      />
                      {inspection
                        ? `安装附加模组和材质包等等（${inspection.optionalFiles.length} 个）`
                        : "安装附加模组和材质包等等"}
                    </label>
                    {inspection && (
                      <p className="helper">
                        {inspection.optionalFiles.slice(0, 6).join("、")}
                        {inspection.optionalFiles.length > 6 ? "…" : ""}
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="input-action resource-download-directory">
                  <Input
                    aria-label="下载文件夹"
                    value={directory}
                    readOnly
                    placeholder="请选择保存文件夹"
                    data-tooltip={directory}
                  />
                  <Button
                    disabled={app.busy}
                    onClick={() =>
                      void app.run(async () => {
                        const selected = await pick(true);
                        if (selected) setDirectory(selected);
                      })
                    }
                  >
                    <FolderOpen size={16} />
                    选择文件夹
                  </Button>
                </div>
                <p className="helper">
                  保存平台提供的原始整合包，下载完成后可通过“导入整合包”安装。
                </p>
              </>
            )}
          </TabPanel>
        </div>
        <div className="dialog-actions">
          <Button disabled={app.busy} onClick={onClose}>
            取消
          </Button>
          <Button primary type="submit" disabled={!canSubmit}>
            <Download size={16} />
            {alreadyQueued
              ? "已加入队列"
              : app.busy
                ? "正在准备…"
                : mode === "install"
                  ? "开始安装"
                  : "开始下载"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
