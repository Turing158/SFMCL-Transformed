import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Download, FolderOpen, Gamepad2, LoaderCircle } from "lucide-react";
import { api, pick } from "../api";
import { Button, Modal, PixelFrame, TabList, TabPanel } from "../components";
import { Input, Select } from "../controls";
import type { ResourceTab } from "../navigation";
import {
  compatibleResourceVersion,
  resourceDependencyKinds,
} from "../resourceDownloads";
import { useApp } from "../store";
import type { ResourceDependency, ResourceFile, Version } from "../types";

export function ResourceDownloadDialog({
  resource,
  title,
  kind,
  queued,
  onQueued,
  onOpenDependency,
  onClose,
}: {
  resource: ResourceFile;
  title: string;
  kind: Exclude<ResourceTab, "minecraft">;
  queued: string[];
  onQueued: (key: string) => void;
  onOpenDependency: (
    dependency: ResourceDependency,
    target?: Version,
  ) => Promise<(() => void) | void>;
  onClose: () => void;
}) {
  const app = useApp();
  const folderOnly = kind === "datapack";
  const downloadName = title.split(/\s+[-–—]\s+/, 1)[0].trim();
  const versions = app.versions.filter((version) =>
    compatibleResourceVersion(resource, version, kind),
  );
  const [destination, setDestination] = useState(
    !folderOnly && versions.length ? "version" : "folder",
  );
  const [targetId, setTargetId] = useState(
    versions.find((version) => version.id === app.data.settings.activeVersion)
      ?.id ??
      versions[0]?.id ??
      "",
  );
  const [directory, setDirectory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [openingDependency, setOpeningDependency] = useState<number | null>(
    null,
  );
  const [readyToClose, setReadyToClose] = useState(false);
  useEffect(() => {
    // Restore focus only after the resource row is enabled again.
    if (readyToClose && !app.busy) onClose();
  }, [readyToClose, app.busy, onClose]);
  const target = versions.find((version) => version.id === targetId);
  const key = JSON.stringify([
    resource.id,
    destination,
    destination === "version"
      ? [app.data.settings.activeDir, targetId]
      : directory,
  ]);
  const alreadyQueued = queued.includes(key);
  const canDownload =
    !!resource.file &&
    !app.busy &&
    !alreadyQueued &&
    (destination === "version" ? !!target : !!directory);
  const dependencyGroups = new Map<
    ResourceDependency["kind"],
    { dependency: ResourceDependency; index: number }[]
  >();
  resource.dependencies.forEach((dependency, index) => {
    const group = dependencyGroups.get(dependency.kind) ?? [];
    group.push({ dependency, index });
    dependencyGroups.set(dependency.kind, group);
  });

  return (
    <Modal
      title={`下载 ${downloadName}`}
      onClose={onClose}
      closeDisabled={app.busy}
    >
      <form
        className="resource-download-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canDownload) return;
          void app.run(async () => {
            setSubmitting(true);
            try {
              await api("resources.download", {
                kind,
                ...(destination === "version"
                  ? { versionId: targetId }
                  : { directory }),
                file: resource.file,
                title,
              });
              onQueued(key);
              setReadyToClose(true);
              app.notify("已加入下载队列");
            } finally {
              setSubmitting(false);
            }
          });
        }}
      >
        <p className="resource-download-name">{resource.file?.path}</p>
        {resource.dependencies.length > 0 && (
          <section
            className="resource-download-dependencies"
            aria-label="前置资源"
          >
            {Array.from(dependencyGroups, ([dependencyKind, group]) => (
              <div
                key={dependencyKind}
                className="resource-download-dependency-group"
              >
                <strong>
                  前置{resourceDependencyKinds[dependencyKind] || "未知类型"}
                </strong>
                <ul
                  aria-label={`前置${resourceDependencyKinds[dependencyKind] || "未知类型"}`}
                >
                  {group.map(({ dependency, index }) => {
                    const name = dependency.name?.trim() || "名称暂不可用";
                    return (
                      <li
                        key={JSON.stringify([
                          dependency.projectId,
                          dependency.versionId,
                          index,
                        ])}
                      >
                        <button
                          type="button"
                          className="resource-dependency-tag badge has-surface"
                          disabled={!dependency.projectId || app.busy}
                          aria-busy={openingDependency === index}
                          aria-label={`查看 ${name} 资源页面`}
                          data-tooltip={
                            dependency.projectId
                              ? name
                              : "暂时无法获取对应资源页面"
                          }
                          onClick={(event) => {
                            const indicator = event.currentTarget.querySelector(
                              ".resource-dependency-loading",
                            );
                            void app.run(async () => {
                              setOpeningDependency(index);
                              let open: (() => void) | void;
                              try {
                                open = await onOpenDependency(
                                  dependency,
                                  destination === "version"
                                    ? target
                                    : undefined,
                                );
                              } finally {
                                // Keep the tag mounted until its loading space has collapsed.
                                flushSync(() => setOpeningDependency(null));
                                await Promise.allSettled(
                                  (indicator?.getAnimations() ?? []).map(
                                    (animation) => animation.finished,
                                  ),
                                );
                              }
                              open?.();
                            });
                          }}
                        >
                          <PixelFrame />
                          <span
                            className="resource-dependency-loading"
                            aria-hidden="true"
                          >
                            <LoaderCircle size={14} className="spin" />
                          </span>
                          <span className="resource-dependency-label">
                            {name}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}
        <div className="resource-download-destination">
          <TabList
            id="resource-download"
            label="下载方式"
            value={destination}
            onValueChange={setDestination}
            items={[
              ...(!folderOnly
                ? [
                    {
                      value: "version",
                      label: "安装到游戏",
                      icon: <Gamepad2 size={16} />,
                    },
                  ]
                : []),
              {
                value: "folder",
                label: "下载到文件夹",
                icon: <FolderOpen size={16} />,
              },
            ]}
          />
          <TabPanel id="resource-download" value={destination}>
            {destination === "version" ? (
              <>
                <Select
                  aria-label="本地游戏版本"
                  value={targetId}
                  onValueChange={setTargetId}
                  disabled={!versions.length || app.busy}
                  autoFocus
                >
                  <option value="">选择兼容版本</option>
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.id}
                    </option>
                  ))}
                </Select>
                <p className="helper">
                  {target
                    ? `${target.version} · ${target.loader}${
                        !(target.isolation ?? app.data.settings.isolation)
                          ? " · 共享游戏目录"
                          : ""
                      }`
                    : versions.length
                      ? "请选择一个兼容的本地游戏版本。"
                      : "没有兼容的本地游戏版本，可改为下载到文件夹。"}
                </p>
              </>
            ) : (
              <>
                <div className="input-action resource-download-directory">
                  <Input
                    id="resource-download-directory"
                    aria-label="下载文件夹"
                    value={directory}
                    placeholder="请选择保存文件夹"
                    readOnly
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
                  {folderOnly
                    ? "数据包需要放入存档的 datapacks 文件夹。可直接选择该文件夹，或下载后手动移入。"
                    : "将资源文件直接保存到所选文件夹。"}
                </p>
              </>
            )}
          </TabPanel>
        </div>
        <div className="dialog-actions">
          <Button disabled={app.busy} onClick={onClose}>
            取消
          </Button>
          <Button primary type="submit" disabled={!canDownload}>
            <Download size={16} />
            {alreadyQueued
              ? "已加入队列"
              : submitting
                ? "正在准备下载…"
                : "开始下载"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
