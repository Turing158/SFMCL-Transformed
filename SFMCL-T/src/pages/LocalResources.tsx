import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  Check,
  CirclePause,
  Folder,
  FolderOpen,
  Globe,
  HardDrive,
  Layers,
  Power,
  RefreshCw,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { SearchField, Select } from "../controls";
import {
  Badge,
  Button,
  Empty,
  PixelFrame,
  ResourceImage,
  TabList,
  TabPanel,
} from "../components";
import { api, confirmAction } from "../api";
import { minecraftDirectoryPath } from "../gameDirectories";
import { useApp } from "../store";
import type { LocalResource, Project, Version } from "../types";
import { usePageActive } from "../PageActivity";
import { useTabContentTransition } from "../useTabContentTransition";
import { LocalResourcePage } from "./LocalResourcePage";
import {
  isLocalResourceDirectory,
  localResourceSize,
  openLocalResource,
} from "../localResources";

const kinds = [
  { value: "mod", label: "模组", icon: <Box size={16} />, folder: "mods" },
  {
    value: "resourcepack",
    label: "材质包",
    icon: <Layers size={16} />,
    folder: "resourcepacks",
  },
  {
    value: "shader",
    label: "光影",
    icon: <Sun size={16} />,
    folder: "shaderpacks",
  },
  {
    value: "world",
    label: "存档",
    icon: <Globe size={16} />,
    folder: "saves",
  },
];
const modPageSize = 20;
type ListedResource = LocalResource & {
  listKey: string;
  sizePending?: boolean;
};

export function LocalResources({
  version,
  onVersionChange,
}: {
  version: Version;
  onVersionChange: (version: Version) => void;
}) {
  const app = useApp();
  const pageActive = usePageActive();
  const resource =
    app.route.detail?.kind === "resources"
      ? app.route.detail.resource
      : undefined;
  const listOnlyKind =
    resource?.kind === "shader" || resource?.kind === "resourcepack"
      ? resource.kind
      : undefined;
  const detail = listOnlyKind ? undefined : resource;
  const [kind, setKind] = useState(listOnlyKind ?? "mod");
  const tabContent = useTabContentTransition(
    kinds.findIndex((item) => item.value === kind),
    !detail,
  );
  const [query, setQuery] = useState("");
  const [modPage, setModPage] = useState(0);
  const [resources, setResources] = useState<Record<string, ListedResource[]>>(
    {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const rootElement = useRef<HTMLElement>(null);
  const previousDetail = useRef(detail);
  const returnPosition = useRef<{
    scrollTop: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const channelReturn = useRef<{
    scrollTop: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const isolation = version.isolation ?? app.data.settings.isolation;
  const root = isolation
    ? version.path
    : minecraftDirectoryPath(version.directory ?? app.data.settings.activeDir);
  const folder = `${root}/${kinds.find((item) => item.value === kind)!.folder}`;
  const compact = kind === "resourcepack" || kind === "world";
  const refresh = () => setRevision((current) => current + 1);
  const openDetail = (resource: LocalResource, trigger: HTMLButtonElement) => {
    returnPosition.current = {
      scrollTop:
        rootElement.current?.closest<HTMLElement>(".page")?.scrollTop ?? 0,
      trigger,
    };
    app.clearError();
    app.navigate({
      page: "versions",
      detail: { kind: "resources", version, resource },
    });
  };
  const openModProject = (project: Project, trigger: HTMLButtonElement) => {
    channelReturn.current = {
      scrollTop:
        rootElement.current?.closest<HTMLElement>(".page")?.scrollTop ?? 0,
      trigger,
    };
    app.navigate({
      page: "resources",
      tab: "mod",
      returnTo: {
        page: "versions",
        detail: { kind: "resources", version, resource: detail },
      },
      resource: {
        kind: "project",
        project,
        initialTab: "description",
        gameVersion: version.version,
        loader: version.loader,
      },
    });
  };
  useLayoutEffect(() => {
    if (!pageActive || !channelReturn.current) return;
    const saved = channelReturn.current;
    const page = rootElement.current?.closest<HTMLElement>(".page");
    if (page) page.scrollTop = saved.scrollTop;
    if (saved.trigger.isConnected) saved.trigger.focus({ preventScroll: true });
    channelReturn.current = null;
  }, [pageActive]);
  useLayoutEffect(() => {
    if (!listOnlyKind) return;
    setKind(listOnlyKind);
    app.navigate({
      page: "versions",
      detail: { kind: "resources", version },
    });
  }, [listOnlyKind, version, app.navigate]);
  useLayoutEffect(() => {
    const page = rootElement.current?.closest<HTMLElement>(".page");
    if (detail && page) page.scrollTop = 0;
    else if (previousDetail.current && page) {
      const saved = returnPosition.current;
      page.scrollTop = saved?.scrollTop ?? 0;
      if (saved?.trigger.isConnected)
        saved.trigger.focus({ preventScroll: true });
      app.clearError();
      returnPosition.current = null;
    }
    previousDetail.current = detail;
  }, [detail]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setResources({});
    setErrors({});
    void Promise.allSettled(
      kinds.map((item) =>
        api<LocalResource[]>("resources.local", {
          kind: item.value,
          versionId: version.id,
          directory: version.directory,
        }),
      ),
    ).then((results) => {
      if (!active) return;
      const next: Record<string, ListedResource[]> = {};
      const failures: Record<string, string> = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled")
          next[kinds[index].value] = result.value.map((resource) => ({
            ...resource,
            listKey: resource.path,
            sizePending:
              resource.entryType === "resourceDirectory" &&
              resource.size === null,
          }));
        else failures[kinds[index].value] = String(result.reason);
      });
      setResources(next);
      setErrors(failures);
      setLoading(false);
      const pending = Object.values(next)
        .flat()
        .filter((item) => item.sizePending);
      // Limit disk work and stop queueing when the version changes or a refresh starts.
      void Promise.all(
        Array.from({ length: Math.min(2, pending.length) }, async () => {
          while (active) {
            const item = pending.shift();
            if (!item) return;
            const size = await api<number>("resources.localSize", {
              kind: item.kind,
              path: item.path,
              versionId: version.id,
              directory: version.directory,
            }).catch(() => null);
            if (!active) return;
            setResources((current) => ({
              ...current,
              [item.kind]: (current[item.kind] || []).map((resource) =>
                resource.path === item.path
                  ? { ...resource, size, sizePending: false }
                  : resource,
              ),
            }));
          }
        }),
      );
    });
    return () => {
      active = false;
    };
  }, [version.id, root, revision]);
  const items = (resources[kind] || []).filter((item) =>
    (kind === "shader"
      ? item.name
      : `${item.name} ${item.authors} ${item.description}`
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const modPages = Math.max(1, Math.ceil(items.length / modPageSize));
  const currentModPage = Math.min(modPage, modPages - 1);
  const visibleItems =
    kind === "mod"
      ? items.slice(
          currentModPage * modPageSize,
          (currentModPage + 1) * modPageSize,
        )
      : items;
  useEffect(() => {
    if (kind === "mod" && !loading && !errors[kind]) setModPage(currentModPage);
  }, [kind, loading, errors, currentModPage]);
  const searchResources = (value: string) => {
    setQuery(value);
    setModPage(0);
  };
  const goToModPage = (value: number) => {
    setModPage(Math.max(0, Math.min(value, modPages - 1)));
    const page = rootElement.current?.closest<HTMLElement>(".page");
    if (page) page.scrollTop = 0;
  };

  return (
    <section
      ref={rootElement}
      className="local-resources"
      aria-label="本地资源"
    >
      <div hidden={!!detail}>
        <header className="local-resources-header">
          <Select
            className="local-version-select"
            aria-label="查看资源的游戏版本"
            value={version.id}
            onValueChange={(id) => {
              const next = app.versions.find((item) => item.id === id);
              if (next) onVersionChange(next);
            }}
          >
            {app.versions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </Select>
          <Badge
            className={`local-isolation-tag ${isolation ? "completed" : "failed"}`}
            role="status"
            aria-label={`版本隔离${isolation ? "已开启" : "未开启"}`}
          >
            <span>版本隔离</span>
            {isolation ? (
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
            ) : (
              <X size={14} strokeWidth={2.5} aria-hidden="true" />
            )}
          </Badge>
        </header>
        <div className="local-resources-toolbar">
          <TabList
            id="version-resources"
            label="本地资源类型"
            value={kind}
            onValueChange={setKind}
            items={kinds.map((item) => ({
              ...item,
              count: resources[item.value]?.length,
            }))}
          />
          <SearchField
            label="搜索本地资源"
            placeholder="搜索本地资源…"
            value={query}
            onValueChange={searchResources}
          />
          <div className="row-actions local-resources-actions">
            <Button
              aria-label="打开目录"
              data-tooltip="打开目录"
              onClick={() =>
                void app.run(() => api("path.open", { path: folder }))
              }
            >
              <FolderOpen size={17} />
            </Button>
            <Button
              aria-label="刷新"
              data-tooltip="刷新"
              disabled={loading || app.busy}
              onClick={refresh}
            >
              <RefreshCw size={17} />
            </Button>
          </div>
        </div>
        <TabPanel ref={tabContent} id="version-resources" value={kind}>
          {loading ? (
            <p className="loading-text" role="status">
              正在读取资源…
            </p>
          ) : errors[kind] ? (
            <div className="inline-error resource-error" role="alert">
              {errors[kind]}
              <Button onClick={refresh}>重试</Button>
            </div>
          ) : items.length ? (
            <>
              <div className="resource-list">
                {visibleItems.map((item) => (
                  <article
                    className={`catalog-project has-surface resource-row local ${compact ? "local-compact-row" : ""} ${kind === "shader" ? "local-shader-row" : item.disabled ? "disabled-resource" : ""}`}
                    key={item.listKey}
                  >
                    <PixelFrame />
                    {kind === "shader" ? (
                      <div className="catalog-project-info local-shader-info">
                        {item.entryType === "directory" ? (
                          <Folder
                            size={20}
                            className="local-shader-symbol"
                            aria-hidden="true"
                          />
                        ) : (
                          <Sun
                            size={20}
                            className="local-shader-symbol"
                            aria-hidden="true"
                          />
                        )}
                        <div className="local-shader-copy">
                          <div className="local-shader-name">
                            <h3 title={item.name}>{item.name}</h3>
                            {isLocalResourceDirectory(item) && (
                              <Badge>文件夹</Badge>
                            )}
                          </div>
                          <span className="local-resource-size">
                            {item.entryType === "directory"
                              ? "普通文件夹"
                              : localResourceSize(item)}
                          </span>
                        </div>
                      </div>
                    ) : kind === "resourcepack" ? (
                      <div className="catalog-project-info local-resource-title">
                        <LocalResourceInfo item={item} compact={compact} />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="catalog-project-info local-resource-title"
                        aria-label={`${item.name} 详情`}
                        onClick={(event) =>
                          openDetail(item, event.currentTarget)
                        }
                      >
                        <LocalResourceInfo item={item} compact={compact} />
                      </button>
                    )}
                    <div className="row-actions local-resource-actions">
                      <Button
                        aria-label={`打开 ${item.name} 所在目录`}
                        data-tooltip="打开所在目录"
                        onClick={() =>
                          void app.run(() => openLocalResource(item))
                        }
                      >
                        <FolderOpen size={17} />
                      </Button>
                      {kind === "mod" && (
                        <Button
                          disabled={app.busy}
                          aria-label={`${item.disabled ? "启用" : "禁用"} ${item.name}`}
                          data-tooltip={item.disabled ? "启用模组" : "禁用模组"}
                          onClick={() =>
                            void app.run(async () => {
                              const disabled = !item.disabled;
                              const path = await api<string>(
                                "resources.toggle",
                                {
                                  versionId: version.id,
                                  directory: version.directory,
                                  path: item.path,
                                  disabled,
                                },
                              );
                              setResources((current) => ({
                                ...current,
                                mod: (current.mod || []).map((resource) =>
                                  resource.path === item.path
                                    ? { ...resource, path, disabled }
                                    : resource,
                                ),
                              }));
                            })
                          }
                        >
                          <Power size={17} />
                        </Button>
                      )}
                      {kind === "resourcepack" &&
                        item.entryType !== "directory" && (
                          <Button
                            danger
                            disabled={app.busy}
                            aria-label={`删除 ${item.name}`}
                            data-tooltip="删除材质包"
                            onClick={async () => {
                              if (
                                await confirmAction(
                                  `删除材质包 ${item.name}？${isLocalResourceDirectory(item) ? "将删除该文件夹及其全部内容。" : ""}`,
                                )
                              )
                                await app.run(async () => {
                                  await api("resources.deletePack", {
                                    versionId: version.id,
                                    directory: version.directory,
                                    path: item.path,
                                  });
                                  refresh();
                                });
                            }}
                          >
                            <Trash2 size={17} />
                          </Button>
                        )}
                    </div>
                  </article>
                ))}
              </div>
              {kind === "mod" && (
                <nav
                  className="pagination catalog-pagination local-mod-pagination"
                  aria-label="本地模组分页"
                >
                  <Button
                    disabled={currentModPage === 0}
                    onClick={() => goToModPage(currentModPage - 1)}
                  >
                    上一页
                  </Button>
                  <span
                    className="page-indicator catalog-page-indicator has-surface"
                    role="status"
                    aria-atomic="true"
                  >
                    <PixelFrame />
                    <span className="page-indicator-text">
                      第 {currentModPage + 1} / {modPages} 页
                    </span>
                  </span>
                  <Button
                    disabled={currentModPage + 1 >= modPages}
                    onClick={() => goToModPage(currentModPage + 1)}
                  >
                    下一页
                  </Button>
                </nav>
              )}
            </>
          ) : (
            <section className="panel has-surface">
              <PixelFrame />
              <Empty
                title={query ? "没有找到匹配资源" : "这里还没有资源"}
                description={
                  query
                    ? "试试其他名称，或清空搜索条件。"
                    : "把资源放入对应目录，或从资源中心安装。"
                }
                action={
                  query ? (
                    <Button onClick={() => searchResources("")}>
                      清空搜索
                    </Button>
                  ) : (
                    <Button
                      onClick={() =>
                        app.openResources(
                          kind === "resourcepack" || kind === "shader"
                            ? kind
                            : "mod",
                        )
                      }
                    >
                      浏览资源中心
                    </Button>
                  )
                }
              />
            </section>
          )}
        </TabPanel>
      </div>
      {detail && (
        <LocalResourcePage
          key={detail.path}
          item={detail}
          version={version}
          onOpenModProject={openModProject}
        />
      )}
    </section>
  );
}

function LocalResourceInfo({
  item,
  compact,
}: {
  item: ListedResource;
  compact: boolean;
}) {
  return (
    <>
      {isLocalResourceDirectory(item) && !item.icon ? (
        <div className="resource-icon local-directory-icon" aria-hidden="true">
          <Folder size={24} />
        </div>
      ) : (
        <ResourceImage path={item.icon} alt="" />
      )}
      <div className="catalog-project-copy">
        <div className="catalog-project-title">
          <h3 title={compact ? item.name : undefined}>{item.name}</h3>
          {isLocalResourceDirectory(item) && <Badge>文件夹</Badge>}
          {item.authors && (
            <span title={compact ? item.authors : undefined}>
              {item.authors}
            </span>
          )}
        </div>
        <p title={compact ? item.description : undefined}>
          {item.entryType === "directory"
            ? "普通文件夹"
            : item.description ||
              (item.kind === "resourcepack" ? "暂无说明" : "点击查看详细信息")}
        </p>
        {(item.version || item.disabled || item.entryType !== "directory") && (
          <div className="catalog-project-meta local-resource-meta">
            <div className="catalog-tags">
              {item.version && (
                <Badge title={compact ? item.version : undefined}>
                  {item.version}
                </Badge>
              )}
              {item.disabled && (
                <Badge className="paused local-resource-status">
                  <CirclePause size={12} aria-hidden="true" />
                  已禁用
                </Badge>
              )}
            </div>
            {item.entryType !== "directory" && (
              <span className="local-resource-size">
                <HardDrive size={13} aria-hidden="true" />
                {localResourceSize(item)}
              </span>
            )}
          </div>
        )}
        {item.error && (
          <span className="local-resource-error danger-text">
            <AlertTriangle size={13} aria-hidden="true" />
            {item.error}
          </span>
        )}
      </div>
    </>
  );
}
