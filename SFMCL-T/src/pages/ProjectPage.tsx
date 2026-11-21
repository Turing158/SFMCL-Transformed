import { useSessionChangeEffect, useSessionState } from "../windowSession";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Input, Select } from "../controls";
import { useApp } from "../store";
import { api, external } from "../api";
import {
  Button,
  Empty,
  ErrorBanner,
  PixelFrame,
  ResourceImage,
  TabList,
  TabPanel,
} from "../components";
import type { Project, ResourceFile } from "../types";
import type { ResourceTab } from "../navigation";
import { ResourceSubpage } from "./ResourceSubpage";
import { useTabContentTransition } from "../useTabContentTransition";
import { ResourceDownloadDialog } from "./ResourceDownloadDialog";
import { ModpackInstallDialog } from "./ModpackInstallDialog";
import { CatalogView, type ResourceView } from "./CatalogView";
import { CatalogItems } from "./CatalogMotion";
import { ProjectFileItem } from "./ProjectFileItem";
import { ResourceSourceBadge } from "../resourceSources";
import { resourceName } from "../resourceNames";

const filePageSize = 20;
const resourceLoaders = {
  mod: ["Fabric", "Forge", "NeoForge", "Quilt", "LiteLoader"],
  resourcepack: ["Minecraft"],
  shader: ["Iris", "OptiFine"],
  datapack: ["datapack"],
  modpack: ["Fabric", "Forge", "NeoForge", "Quilt"],
};

export function ProjectPage({
  project,
  kind,
  gameVersion,
  loader,
  view,
  onViewChange,
  initialTab = "description",
}: {
  project: Project;
  kind: Exclude<ResourceTab, "minecraft">;
  gameVersion: string;
  loader: string;
  view: ResourceView;
  onViewChange: (view: ResourceView) => void;
  initialTab?: "description" | "files";
}) {
  const app = useApp();
  const [detail, setDetail] = useState(project);
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [filePage, setFilePage] = useSessionState("ProjectPage.filePage", 0);
  const fileResults = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useSessionState<string>("ProjectPage.tab", initialTab);
  const tabContent = useTabContentTransition(tab === "description" ? 0 : 1);
  const [versionInput, setVersionInput] = useSessionState(
    "ProjectPage.versionInput",
    gameVersion,
  );
  const [fileVersion, setFileVersion] = useSessionState(
    "ProjectPage.fileVersion",
    gameVersion,
  );
  const [fileLoader, setFileLoader] = useSessionState(
    "ProjectPage.fileLoader",
    kind === "datapack"
      ? "datapack"
      : kind === "mod" || kind === "modpack"
        ? loader
        : "",
  );
  const [download, setDownload] = useState<ResourceFile | null>(null);
  const [retry, setRetry] = useState(0);
  const [queued, setQueued] = useState<string[]>([]);
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loaderOptions =
    project.source === "curseforge" && kind !== "mod" && kind !== "modpack"
      ? []
      : resourceLoaders[kind];
  useEffect(() => {
    const timer = setTimeout(() => setFileVersion(versionInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [versionInput]);
  useEffect(() => {
    let active = true;
    setDetailError("");
    void api<Project>("resources.detail", {
      source: project.source,
      id: project.id,
    })
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((reason) => {
        if (active) setDetailError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [project.id, project.source, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setFiles([]);
    void api<ResourceFile[]>("resources.files", {
      source: project.source,
      id: project.id,
      gameVersion: fileVersion,
      loader: fileLoader,
    })
      .then((value) => {
        if (active) setFiles(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [project.id, project.source, fileVersion, fileLoader, retry]);
  useSessionChangeEffect(() => {
    setFilePage(0);
  }, [project.id, project.source, fileVersion, fileLoader, retry]);
  const filePages = Math.max(1, Math.ceil(files.length / filePageSize));
  const currentFilePage = Math.min(filePage, filePages - 1);
  const pageFiles = useMemo(
    () =>
      files.slice(
        currentFilePage * filePageSize,
        (currentFilePage + 1) * filePageSize,
      ),
    [files, currentFilePage],
  );
  const goToFilePage = (page: number) => {
    setFilePage(Math.max(0, Math.min(page, filePages - 1)));
    fileResults.current?.scrollIntoView({ block: "start" });
  };
  const plainBody =
    detail.source === "curseforge"
      ? new DOMParser().parseFromString(detail.body, "text/html").body
          .textContent || ""
      : detail.body;
  return (
    <ResourceSubpage
      title={resourceName(detail.title, detail.localizedName)}
      tab={kind}
    >
      <div className="project-heading">
        <ResourceImage
          path={detail.icon}
          alt={resourceName(detail.title, detail.localizedName)}
        />
        <div>
          <p>{detail.description}</p>
          <small>
            {detail.author} · <ResourceSourceBadge source={detail.source} /> ·{" "}
            {detail.downloads.toLocaleString()} 次下载
          </small>
        </div>
        <Button onClick={() => void app.run(() => external(detail.website))}>
          <ExternalLink size={16} />
          项目主页
        </Button>
      </div>
      <TabList
        id="project"
        label="资源详情"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "description", label: "项目介绍" },
          {
            value: "files",
            label: "下载",
            count: files.length,
            loading,
          },
        ]}
      />
      <TabPanel ref={tabContent} id="project" value={tab}>
        <ErrorBanner message={detailError || error}>
          <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </ErrorBanner>
        {tab === "description" ? (
          <div className="markdown">
            <ReactMarkdown
              skipHtml
              components={{
                a: ({ href, children }) => (
                  <button
                    className="inline-link"
                    onClick={() => {
                      if (href) void app.run(() => external(href));
                    }}
                  >
                    {children}
                  </button>
                ),
              }}
            >
              {plainBody || detail.description}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="project-files" ref={fileResults}>
            <div className="project-file-toolbar">
              <div
                className="project-file-filters"
                role="group"
                aria-label="资源版本筛选"
              >
                <Input
                  aria-label="筛选游戏版本"
                  placeholder="全部版本"
                  value={versionInput}
                  onChange={(event) => setVersionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      setFileVersion(versionInput.trim());
                  }}
                />
                {kind !== "datapack" && (
                  <Select
                    aria-label="筛选加载器"
                    value={fileLoader}
                    onValueChange={setFileLoader}
                    disabled={!loaderOptions.length}
                    data-tooltip={
                      loaderOptions.length
                        ? undefined
                        : "此来源未提供该资源的加载器信息"
                    }
                  >
                    <option value="">全部加载器</option>
                    {loaderOptions.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </Select>
                )}
              </div>
              <CatalogView
                value={view}
                onValueChange={onViewChange}
                aria-controls="project-file-results"
              />
            </div>
            {loading && (
              <div className="project-file-loading loading-text" role="status">
                <LoaderCircle size={28} className="spin" aria-hidden="true" />
                <span>加载中...</span>
              </div>
            )}
            {files.length === 0 && !loading && !error && (
              <Empty
                title="未找到兼容文件"
                description={
                  kind === "datapack"
                    ? "试试其他游戏版本，或清除筛选后重试。"
                    : "试试其他游戏版本或加载器，或清除筛选后重试。"
                }
              />
            )}
            <CatalogItems
              id="project-file-results"
              className="project-file-results"
              view={view}
              revision={pageFiles}
              label="下载列表"
              busy={loading}
            >
              {pageFiles.map((file) => (
                <ProjectFileItem
                  key={file.id}
                  resource={file}
                  disabled={app.busy || loading}
                  onSelect={() => {
                    app.clearError();
                    setDownload(file);
                  }}
                />
              ))}
            </CatalogItems>
            {!loading && !error && files.length > 0 && (
              <nav
                className="pagination catalog-pagination project-file-pagination"
                aria-label="下载列表分页"
              >
                <Button
                  aria-controls="project-file-results"
                  disabled={currentFilePage === 0}
                  onClick={() => goToFilePage(currentFilePage - 1)}
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
                    第 {currentFilePage + 1} / {filePages} 页
                  </span>
                </span>
                <Button
                  aria-controls="project-file-results"
                  disabled={currentFilePage + 1 >= filePages}
                  onClick={() => goToFilePage(currentFilePage + 1)}
                >
                  下一页
                </Button>
              </nav>
            )}
          </div>
        )}
      </TabPanel>
      {download && kind === "modpack" && (
        <ModpackInstallDialog
          resource={download}
          title={detail.title}
          localizedName={detail.localizedName}
          queued={queued}
          onQueued={(key) => setQueued((current) => [...current, key])}
          onClose={() => {
            app.clearError();
            setDownload(null);
          }}
        />
      )}
      {download && kind !== "modpack" && (
        <ResourceDownloadDialog
          resource={download}
          title={detail.title}
          localizedName={detail.localizedName}
          kind={kind}
          queued={queued}
          onQueued={(key) => setQueued((current) => [...current, key])}
          onOpenDependency={async (dependency, target) => {
            if (!dependency.projectId) return;
            const project = await api<Project>("resources.detail", {
              source: detail.source,
              id: dependency.projectId,
            });
            const dependencyKind = dependency.kind;
            if (
              dependencyKind === "mod" ||
              dependencyKind === "resourcepack" ||
              dependencyKind === "shader" ||
              dependencyKind === "datapack"
            ) {
              const preferredLoader =
                target?.loader ||
                (kind === "mod" ? fileLoader : "") ||
                (download.loaders.length === 1 ? download.loaders[0] : "");
              return () => {
                setDownload(null);
                app.navigate({
                  page: "resources",
                  tab: dependencyKind,
                  returnTo: {
                    page: "resources",
                    tab: kind,
                    returnTo:
                      app.route.page === "resources"
                        ? app.route.returnTo
                        : undefined,
                    resource: {
                      kind: "project",
                      project: detail,
                      initialTab: tab === "files" ? "files" : "description",
                      gameVersion: fileVersion,
                      loader: fileLoader,
                    },
                  },
                  resource: {
                    kind: "project",
                    project,
                    initialTab: "files",
                    gameVersion:
                      target?.version ||
                      fileVersion ||
                      (download.gameVersions.length === 1
                        ? download.gameVersions[0]
                        : ""),
                    loader:
                      dependencyKind === "mod"
                        ? resourceLoaders.mod.find(
                            (loader) =>
                              loader.toLowerCase() ===
                              preferredLoader.toLowerCase(),
                          ) || ""
                        : "",
                  },
                });
              };
            } else {
              await external(project.website);
            }
          }}
          onClose={() => {
            app.clearError();
            setDownload(null);
          }}
        />
      )}
    </ResourceSubpage>
  );
}
