import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Download, FolderOpen, Gamepad2, LoaderCircle } from "lucide-react";
import { api, pick } from "../api";
import { Button, Modal, PixelFrame, TabList, TabPanel } from "../components";
import { Checkbox, Input, Select } from "../controls";
import type { ResourceTab } from "../navigation";
import {
  compatibleResourceVersion,
  resourceDependencyKinds,
} from "../resourceDownloads";
import { useApp } from "../store";
import type {
  DatapackBrowseTarget,
  DatapackWorld,
  LocalizedName,
  ResourceDependency,
  ResourceFile,
  ResourceInstallPlan,
  Version,
} from "../types";
import { resourceName } from "../resourceNames";

export function ResourceDownloadDialog({
  resource,
  source,
  projectId,
  title,
  localizedName,
  kind,
  datapackTarget,
  queued,
  onQueued,
  onOpenDependency,
  onClose,
}: {
  resource: ResourceFile;
  source: string;
  projectId: string;
  title: string;
  localizedName?: LocalizedName | null;
  kind: Exclude<ResourceTab, "minecraft">;
  datapackTarget?: DatapackBrowseTarget;
  queued: string[];
  onQueued: (key: string) => void;
  onOpenDependency: (
    dependency: ResourceDependency,
    target?: Version,
    world?: DatapackBrowseTarget,
  ) => Promise<(() => void) | void>;
  onClose: () => void;
}) {
  const app = useApp();
  const datapack = kind === "datapack";
  const downloadName = title.split(/\s+[-–—]\s+/, 1)[0].trim();
  const versions = (
    datapackTarget ? [datapackTarget.version] : app.versions
  ).filter((version) => compatibleResourceVersion(resource, version, kind));
  const [destination, setDestination] = useState(
    datapack || versions.length ? "version" : "folder",
  );
  const [targetId, setTargetId] = useState(
    versions.find((version) => version.id === app.data.settings.activeVersion)
      ?.id ??
      versions[0]?.id ??
      "",
  );
  const [directory, setDirectory] = useState("");
  const [worldId, setWorldId] = useState(datapackTarget?.target.worldId ?? "");
  const [worldsState, setWorldsState] = useState<{
    key: string;
    worlds?: DatapackWorld[];
    error?: string;
  }>();
  const [worldsRevision, setWorldsRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [openingDependency, setOpeningDependency] = useState<number | null>(
    null,
  );
  const [readyToClose, setReadyToClose] = useState(false);
  const [autoDependencies, setAutoDependencies] = useState(true);
  const [enablePaths, setEnablePaths] = useState<string[]>([]);
  const [retryPlan, setRetryPlan] = useState(0);
  const [planState, setPlanState] = useState<{
    key: string;
    plan?: ResourceInstallPlan;
    error?: string;
  } | null>(null);
  useEffect(() => {
    // Restore focus only after the resource row is enabled again.
    if (readyToClose && !app.busy) onClose();
  }, [readyToClose, app.busy, onClose]);
  const target = versions.find((version) => version.id === targetId);
  const gameDirectory =
    datapackTarget?.target.directory ??
    target?.directory ??
    app.data.settings.activeDir;
  const worldsKey = JSON.stringify([
    gameDirectory,
    target?.id,
    target?.isolation,
    worldsRevision,
  ]);
  const loadedWorlds = worldsState?.key === worldsKey ? worldsState : undefined;
  const selectedWorld = loadedWorlds?.worlds?.find(
    (world) => world.id === worldId,
  );
  const worldTarget =
    target && selectedWorld
      ? {
          directory: gameDirectory,
          versionId: target.id,
          worldId: selectedWorld.id,
        }
      : undefined;
  const installDatapack = datapack && destination === "version";
  useEffect(() => {
    if (!installDatapack || !targetId || !target) return;
    let current = true;
    void api<DatapackWorld[]>("resources.datapacks.worlds", {
      directory: gameDirectory,
      versionId: targetId,
    }).then(
      (worlds) => {
        if (current) setWorldsState({ key: worldsKey, worlds });
      },
      (error) => {
        if (current) setWorldsState({ key: worldsKey, error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [installDatapack, targetId, gameDirectory, worldsKey, !!target]);
  const installDependencies =
    kind === "mod" && destination === "version" && autoDependencies;
  const planKey = JSON.stringify([
    source,
    projectId,
    resource.id,
    app.data.settings.activeDir,
    targetId,
    target?.isolation,
    app.data.settings.isolation,
    retryPlan,
  ]);
  const currentPlan = planState?.key === planKey ? planState : null;
  const plan = currentPlan?.plan;
  useEffect(() => {
    if (!installDependencies || !targetId) return;
    let live = true;
    let token: string | null = null;
    setEnablePaths([]);
    setPlanState(null);
    void api<ResourceInstallPlan>("resources.installPlan", {
      source,
      projectId,
      fileId: resource.id,
      directory: app.data.settings.activeDir,
      versionId: targetId,
    })
      .then((result) => {
        token = result.token;
        if (live) setPlanState({ key: planKey, plan: result });
        else if (token)
          void api("resources.discardInstallPlan", { token }).catch(() => {});
      })
      .catch((error) => {
        if (live)
          setPlanState({
            key: planKey,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      live = false;
      if (token)
        void api("resources.discardInstallPlan", { token }).catch(() => {});
    };
  }, [
    installDependencies,
    planKey,
    source,
    projectId,
    resource.id,
    app.data.settings.activeDir,
    targetId,
  ]);
  const key = JSON.stringify([
    resource.id,
    destination,
    destination === "version"
      ? [app.data.settings.activeDir, targetId]
      : directory,
  ]);
  const alreadyQueued = !installDatapack && queued.includes(key);
  const canDownload =
    !!resource.file &&
    !app.busy &&
    !alreadyQueued &&
    (!installDependencies ||
      (!!plan?.token &&
        !plan.issues.length &&
        plan.items.every(
          (item) =>
            item.status !== "disabled" || enablePaths.includes(item.path),
        ))) &&
    (destination === "version"
      ? datapack
        ? !!worldTarget
        : !!target
      : !!directory);
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
      title={`下载 ${resourceName(downloadName, localizedName)}`}
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
              if (installDatapack) {
                await api("resources.datapacks.install", {
                  target: worldTarget,
                  file: resource.file,
                  title: `${title} → ${selectedWorld?.name}`,
                });
              } else if (installDependencies) {
                await api("resources.install", {
                  token: plan!.token,
                  directory: app.data.settings.activeDir,
                  versionId: targetId,
                  enablePaths,
                });
              } else
                await api("resources.download", {
                  kind,
                  source,
                  ...(destination === "version"
                    ? { versionId: targetId }
                    : { directory }),
                  file: resource.file,
                  title,
                });
              if (!installDatapack) onQueued(key);
              setReadyToClose(true);
              app.notify(
                installDependencies
                  ? "模组与前置已加入安装队列"
                  : installDatapack
                    ? "数据包已加入存档安装队列"
                    : "已加入下载队列",
              );
            } catch (error) {
              if (installDependencies) setRetryPlan((value) => value + 1);
              throw error;
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
                                  installDatapack && target && worldTarget
                                    ? { version: target, target: worldTarget }
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
              {
                value: "version",
                label: datapack ? "安装到存档" : "安装到游戏",
                icon: <Gamepad2 size={16} />,
              },
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
                  onValueChange={(value) => {
                    setTargetId(value);
                    setWorldId("");
                    setWorldsRevision((revision) => revision + 1);
                  }}
                  disabled={!versions.length || app.busy || !!datapackTarget}
                  autoFocus={!datapackTarget}
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
                {datapack && target && (
                  <div className="datapack-world-selector">
                    <Select
                      aria-label="目标存档"
                      value={selectedWorld?.id ?? ""}
                      onValueChange={setWorldId}
                      disabled={
                        !loadedWorlds?.worlds?.length ||
                        app.busy ||
                        !!datapackTarget
                      }
                    >
                      <option value="">选择存档</option>
                      {loadedWorlds?.worlds
                        ?.filter(
                          (world) =>
                            !datapackTarget ||
                            world.id === datapackTarget.target.worldId,
                        )
                        .map((world) => (
                          <option key={world.id} value={world.id}>
                            {`${world.name} · ${world.id} · ${world.version || "保存版本未知"}`}
                          </option>
                        ))}
                    </Select>
                    {!loadedWorlds && (
                      <p className="helper" role="status">
                        正在读取存档…
                      </p>
                    )}
                    {loadedWorlds?.error && (
                      <>
                        <p className="inline-error" role="alert">
                          {loadedWorlds.error}
                        </p>
                        <Button
                          disabled={app.busy}
                          onClick={() =>
                            setWorldsRevision((revision) => revision + 1)
                          }
                        >
                          重试
                        </Button>
                      </>
                    )}
                    {loadedWorlds?.worlds &&
                      (datapackTarget
                        ? !selectedWorld
                        : !loadedWorlds.worlds.length) && (
                        <p className="helper">
                          {datapackTarget
                            ? "该存档已不在所选版本的存档目录中。"
                            : "所选版本还没有存档，可改为下载到文件夹。"}
                        </p>
                      )}
                    {selectedWorld && (
                      <>
                        <p className="helper">
                          {target.id} → {selectedWorld.name}（{selectedWorld.id}
                          ）
                          {!(target.isolation ?? app.data.settings.isolation) &&
                            " · 共享存档"}
                        </p>
                        {selectedWorld.version &&
                          target.version !== selectedWorld.version && (
                            <p className="helper">
                              此存档上次由 Minecraft {selectedWorld.version}{" "}
                              保存。
                            </p>
                          )}
                      </>
                    )}
                  </div>
                )}
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
                  {datapack
                    ? "数据包需要放入存档的 datapacks 文件夹。可直接选择该文件夹，或下载后手动移入。"
                    : "将资源文件直接保存到所选文件夹。"}
                </p>
              </>
            )}
          </TabPanel>
        </div>
        {kind === "mod" && destination === "version" && (
          <section
            className="resource-install-plan"
            aria-label="模组安装清单"
            aria-busy={installDependencies && !!target && !currentPlan}
          >
            <label className="resource-install-option">
              <Checkbox
                checked={autoDependencies}
                onChange={(event) => setAutoDependencies(event.target.checked)}
                disabled={app.busy}
              />
              自动安装必需前置依赖
            </label>
            {!autoDependencies ? (
              <p className="helper">
                仅下载主模组，缺少前置可能导致游戏无法启动。
              </p>
            ) : !target ? (
              <p className="helper">选择兼容版本后检查前置依赖。</p>
            ) : !currentPlan ? (
              <p className="helper" role="status">
                <LoaderCircle size={14} className="spin" />{" "}
                正在检查前置与本地文件…
              </p>
            ) : (
              <>
                {plan?.items.length ? (
                  <ul className="resource-install-items">
                    {plan.items.map((item) => (
                      <li key={item.projectId}>
                        <div>
                          {item.main ? (
                            <strong>{item.name}（主模组）</strong>
                          ) : (
                            <button
                              type="button"
                              className="resource-install-name"
                              disabled={app.busy}
                              aria-label={`查看 ${item.name} 资源页面`}
                              onClick={() =>
                                void app.run(async () => {
                                  const open = await onOpenDependency(
                                    {
                                      projectId: item.projectId,
                                      versionId: item.versionId,
                                      name: item.name,
                                      kind: item.kind,
                                    },
                                    target,
                                  );
                                  open?.();
                                })
                              }
                            >
                              {item.name}
                            </button>
                          )}
                          <span>{item.version}</span>
                        </div>
                        {item.status === "disabled" ? (
                          <label className="resource-install-option">
                            <Checkbox
                              aria-label={`启用已有 ${item.name}`}
                              checked={enablePaths.includes(item.path)}
                              disabled={app.busy}
                              onChange={(event) =>
                                setEnablePaths((current) =>
                                  event.target.checked
                                    ? [...current, item.path]
                                    : current.filter(
                                        (path) => path !== item.path,
                                      ),
                                )
                              }
                            />
                            启用已有文件
                          </label>
                        ) : (
                          <span className="helper">
                            {item.status === "installed"
                              ? "已安装，跳过下载"
                              : "需要安装"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {currentPlan.error && (
                  <p className="inline-error" role="alert">
                    {currentPlan.error}
                  </p>
                )}
                {plan?.issues.map((issue) => (
                  <p className="inline-error" role="alert" key={issue}>
                    {issue}
                  </p>
                ))}
                {plan?.warnings.map((warning) => (
                  <p className="helper" key={warning}>
                    {warning}
                  </p>
                ))}
                <Button
                  disabled={app.busy}
                  onClick={() => setRetryPlan((value) => value + 1)}
                >
                  重新检查前置
                </Button>
              </>
            )}
          </section>
        )}
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
                : installDependencies || installDatapack
                  ? "开始安装"
                  : "开始下载"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
