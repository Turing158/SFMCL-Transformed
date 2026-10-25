import { SearchField, Select } from "../controls";
import { useEffect, useId, useState } from "react";
import {
  Box,
  Download,
  Check,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
} from "lucide-react";
import { PageHeader } from "../PageHeader";
import { LocalResources } from "./LocalResources";
import { VersionSettingsPage } from "./VersionSettings";
import { ModpackInstallDialog } from "./ModpackInstallDialog";
import { CatalogView } from "./CatalogView";
import {
  gameDirectoryName,
  gameDirectoryPath,
  minecraftDirectoryPath,
} from "../gameDirectories";
import { useApp } from "../store";
import { api, confirmAction, pick } from "../api";
import { Badge, Button, Empty, ResourceImage, PixelFrame } from "../components";
import type { Version } from "../types";
import { versionIcon } from "../versionIcon";
import { VersionManageDialog } from "../VersionManageDialog";
import { versionPayload } from "../versionActions";
import { useAllVersions } from "../useAllVersions";
import { matchesVersionFilter } from "../installOptions";
import "../versions.css";

const viewKey = "sfmcl-t.versions.view";
const allDirectories = "__all_directories__";

export function Versions() {
  const app = useApp();
  const selectionId = useId();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loaderFilter, setLoaderFilter] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const s = app.data.settings;
  const all = useAllVersions(showAll, s.gameDirs, app.versionsRevision);
  const versions = showAll
    ? all.versions
    : app.versions.map((version) => ({
        ...version,
        directory: version.directory ?? s.activeDir,
      }));
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(viewKey) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, view);
    } catch {
      /* Keep switching available when webview storage is unavailable. */
    }
  }, [view]);
  const [detail, setDetail] = useState<Version | null>(null);
  const [importPack, setImportPack] = useState(false);
  const current = app.route;
  const currentVersion = current.detail
    ? (versions.find(
        (version) => version.path === current.detail.version.path,
      ) ?? current.detail.version)
    : null;
  const localVersion =
    current.detail?.kind === "resources" ? currentVersion : null;
  const settingsVersion =
    current.detail?.kind === "settings" ? currentVersion : null;
  async function addDir() {
    const selected = await pick(true);
    if (selected) {
      const directory = gameDirectoryPath(selected);
      const existing = s.gameDirs.find(
        (entry) => gameDirectoryPath(entry.path) === directory,
      );
      const path = existing?.path || directory;
      const gameDirs = existing
        ? s.gameDirs
        : [
            ...s.gameDirs,
            {
              name: path.split(/[\\/]/).filter(Boolean).pop() || "游戏目录",
              path,
            },
          ];
      await app.save({ ...s, gameDirs, activeDir: path, activeVersion: "" });
      setShowAll(false);
    }
  }
  const loaderOptions = [
    ...new Set([
      ...versions.map((version) => version.loader),
      ...(loaderFilter ? [loaderFilter] : []),
    ]),
  ].sort((a, b) =>
    a === "Vanilla" ? -1 : b === "Vanilla" ? 1 : a.localeCompare(b),
  );
  const filtersActive = typeFilter !== "all" || !!loaderFilter || favoritesOnly;
  const items = versions.filter(
    (v) =>
      v.id.toLowerCase().includes(query.toLowerCase()) &&
      matchesVersionFilter({ id: v.version, type: v.kind }, typeFilter) &&
      (!loaderFilter || v.loader === loaderFilter) &&
      (!favoritesOnly || v.favorite),
  );
  const noMatches = versions.length > 0 && (!!query || filtersActive);
  const resetSearchAndFilters = () => {
    setQuery("");
    setTypeFilter("all");
    setLoaderFilter("");
    setFavoritesOnly(false);
  };
  const selected = (version: Version) =>
    s.activeVersion === version.id && s.activeDir === version.directory;
  if (settingsVersion)
    return (
      <VersionSettingsPage
        key={settingsVersion.path}
        version={settingsVersion}
      />
    );
  if (localVersion)
    return (
      <LocalResources
        key={localVersion.path}
        version={localVersion}
        onVersionChange={(version) => app.openVersionPage("resources", version)}
      />
    );
  return (
    <div className="version-management">
      <PageHeader
        icon={<Box />}
        eyebrow="YOUR WORLDS"
        title="版本管理"
        action={
          <div className="modpack-source-actions">
            <Button onClick={() => setImportPack(true)}>
              <Download size={17} />
              导入整合包
            </Button>
            <Button primary onClick={() => app.openResources("minecraft")}>
              <Plus size={17} />
              安装新版本
            </Button>
          </div>
        }
      />
      <div className="toolbar panel has-surface versions-directory-toolbar">
        <PixelFrame />
        <FolderOpen size={20} aria-hidden="true" />
        <Select
          className="versions-directory-select"
          aria-label="游戏目录"
          value={showAll ? allDirectories : s.activeDir}
          displayValue={
            showAll
              ? "全部"
              : s.activeDir
                ? gameDirectoryPath(s.activeDir)
                : "尚未添加目录"
          }
          animateValue
          disabled={app.busy}
          onValueChange={(value) => {
            if (value === allDirectories) {
              setShowAll(true);
              return;
            }
            setShowAll(false);
            if (value !== s.activeDir)
              void app.run(() =>
                app.save({ ...s, activeDir: value, activeVersion: "" }),
              );
          }}
        >
          {s.gameDirs.length === 0 && <option value="">尚未添加目录</option>}
          <option value={allDirectories}>全部</option>
          {s.gameDirs.map((d) => (
            <option key={d.path} value={d.path}>
              {gameDirectoryName(d)} · {gameDirectoryPath(d.path)}
            </option>
          ))}
        </Select>
        <button
          className="icon-button has-surface"
          aria-label="添加游戏目录"
          onClick={() => void app.run(addDir)}
        >
          <PixelFrame />
          <Plus size={18} />
        </button>
        <button
          className="icon-button has-surface"
          aria-label="打开游戏目录"
          disabled={showAll || !s.activeDir}
          onClick={() =>
            void app.run(() =>
              api("path.open", { path: minecraftDirectoryPath(s.activeDir) }),
            )
          }
        >
          <PixelFrame />
          <FolderOpen size={18} />
        </button>
        <button
          className="icon-button has-surface"
          aria-label="移除目录记录"
          disabled={showAll || !s.activeDir}
          onClick={async () => {
            if (
              await confirmAction(
                "从列表中移除此目录？磁盘上的游戏文件会保留。",
              )
            )
              await app.run(async () => {
                const dirs = s.gameDirs.filter((d) => d.path !== s.activeDir);
                await app.save({
                  ...s,
                  gameDirs: dirs,
                  activeDir: dirs[0]?.path || "",
                  activeVersion: "",
                });
              }, "目录已从列表移除");
          }}
        >
          <PixelFrame />
          <Trash2 size={17} />
        </button>
        <button
          className="icon-button has-surface"
          aria-label="刷新版本"
          disabled={app.busy || (showAll && all.loading)}
          onClick={() => (showAll ? all.refresh() : void app.run(app.refresh))}
        >
          <PixelFrame />
          <RefreshCw size={17} />
        </button>
      </div>
      <section className="versions-local" aria-label="本地游戏">
        <div className="section-heading versions-heading">
          <SearchField
            label="搜索版本名称"
            placeholder="搜索版本名称"
            value={query}
            onValueChange={setQuery}
          />
          <div className="versions-filters" role="group" aria-label="版本筛选">
            <Select
              className="versions-type-filter"
              aria-label="筛选版本类型"
              aria-controls="local-version-results"
              data-active={typeFilter !== "all" || undefined}
              value={typeFilter}
              onValueChange={setTypeFilter}
            >
              <option value="all">全部类型</option>
              <option value="release">正式版</option>
              <option value="snapshot">快照版</option>
              <option value="april">愚人节</option>
              <option value="old">历史版</option>
            </Select>
            <Select
              className="versions-loader-filter"
              aria-label="筛选加载器"
              aria-controls="local-version-results"
              data-active={!!loaderFilter || undefined}
              value={loaderFilter}
              onValueChange={setLoaderFilter}
            >
              <option value="">全部加载器</option>
              {loaderOptions.map((loader) => (
                <option key={loader} value={loader}>
                  {loader === "Vanilla" ? "原版" : loader}
                </option>
              ))}
            </Select>
            <Button
              className="versions-favorite-filter"
              aria-label="仅显示收藏版本"
              aria-pressed={favoritesOnly}
              aria-controls="local-version-results"
              data-tooltip="仅收藏"
              onClick={() => setFavoritesOnly((value) => !value)}
            >
              <Star size={16} fill={favoritesOnly ? "currentColor" : "none"} />
              <span>仅收藏</span>
            </Button>
          </div>
          <div className="versions-tools">
            <span
              className="count has-surface"
              aria-label={`显示 ${items.length} 个版本，共 ${versions.length} 个`}
              data-tooltip={`显示 ${items.length} / ${versions.length} 个版本`}
            >
              <PixelFrame />
              {items.length}
            </span>
            <CatalogView
              className="version-view"
              value={view}
              onValueChange={setView}
              aria-controls="local-version-results"
            />
          </div>
        </div>
        {showAll && all.errors.length > 0 && (
          <div
            className="panel has-surface versions-directory-errors"
            role="alert"
          >
            <PixelFrame />
            <p>部分文件夹读取失败，已显示其余文件夹中的版本。</p>
            {all.errors.map((error) => (
              <p key={error} className="inline-error">
                {error}
              </p>
            ))}
            <Button onClick={all.refresh}>重新读取</Button>
          </div>
        )}
        <div id="local-version-results" aria-busy={showAll && all.loading}>
          {showAll && all.loading ? (
            <div className="versions-loading">
              <div className="versions-loading-status" role="status">
                <LoaderCircle
                  className="versions-loading-spinner"
                  size={28}
                  aria-hidden="true"
                />
                <span>加载中...</span>
              </div>
              <div
                className={`version-grid ${view === "list" ? "version-list" : ""}`}
                aria-hidden="true"
              >
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={index}
                    className="has-surface panel version-card versions-skeleton"
                  >
                    <PixelFrame />
                    <span className="resource-icon versions-skeleton-block" />
                    <div className="version-copy versions-skeleton-copy">
                      <span className="versions-skeleton-block versions-skeleton-title" />
                      <span className="versions-skeleton-block versions-skeleton-meta" />
                      <span className="versions-skeleton-block versions-skeleton-directory" />
                    </div>
                    <div className="version-actions">
                      <span className="versions-skeleton-block versions-skeleton-action" />
                      <span className="versions-skeleton-block versions-skeleton-action" />
                      <span className="versions-skeleton-block versions-skeleton-action" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : items.length === 0 ? (
            <section className="panel has-surface">
              <PixelFrame />
              <Empty
                title={noMatches ? "没有符合条件的版本" : "你的世界，即将开始"}
                description={
                  noMatches
                    ? "试试其他名称或筛选条件，或清空搜索与筛选。"
                    : "选择一个已有游戏目录，或下载新的 Minecraft 版本。"
                }
                action={
                  noMatches ? (
                    <Button onClick={resetSearchAndFilters}>
                      清空搜索与筛选
                    </Button>
                  ) : (
                    <div className="row-actions">
                      <Button onClick={() => void app.run(addDir)}>
                        <FolderOpen size={16} />
                        添加游戏目录
                      </Button>
                      <Button
                        primary
                        onClick={() => app.openResources("minecraft")}
                      >
                        <Download size={16} />
                        安装新版本
                      </Button>
                    </div>
                  )
                }
              />
            </section>
          ) : (
            <div
              key={showAll ? allDirectories : s.activeDir}
              className={`version-grid ${view === "list" ? "version-list" : ""}`}
            >
              {items.map((v) => (
                <article
                  className={`has-surface panel version-card ${selected(v) ? "selected" : ""}`}
                  key={v.path}
                  data-directory={v.directory}
                >
                  <PixelFrame />
                  <button
                    id={`${selectionId}-${encodeURIComponent(v.path)}`}
                    type="button"
                    className="version-select"
                    data-tooltip={v.id}
                    aria-label={`选择 ${v.id}`}
                    aria-pressed={selected(v)}
                    disabled={app.busy || !!v.error}
                    onClick={() => void app.selectVersion(v)}
                  />
                  <ResourceImage path={versionIcon(v)} alt={v.loader} />
                  <div className="version-copy">
                    <div className="version-title">
                      <h3 className="version-name" data-tooltip={v.id}>
                        {v.id}
                      </h3>
                      <label
                        className="version-kind"
                        htmlFor={`${selectionId}-${encodeURIComponent(v.path)}`}
                      >
                        <Badge>
                          {v.kind === "release" ? "正式版" : "快照 / 历史版"}
                        </Badge>
                      </label>
                    </div>
                    <p className="version-meta">
                      {v.loader} · Java {v.javaMajor}
                    </p>
                    {showAll && (
                      <p
                        className="version-directory"
                        data-tooltip={gameDirectoryPath(v.directory ?? "")}
                      >
                        {gameDirectoryName(
                          s.gameDirs.find(
                            (directory) => directory.path === v.directory,
                          ) ?? {
                            name: v.directory ?? "",
                            path: v.directory ?? "",
                          },
                        )}
                      </p>
                    )}
                  </div>
                  <span className="version-selection" aria-hidden="true">
                    <Check size={14} /> 已选择
                  </span>
                  <div className="version-actions">
                    <button
                      type="button"
                      className="icon-button has-surface version-favorite"
                      data-tooltip={v.favorite ? "取消收藏" : "收藏版本"}
                      aria-label={`${v.favorite ? "取消收藏" : "收藏"} ${v.id}`}
                      aria-pressed={!!v.favorite}
                      disabled={app.busy}
                      onClick={() =>
                        void app.mutate(
                          "versions.favorite",
                          versionPayload(v, { favorite: !v.favorite }),
                          v.favorite ? "已取消收藏" : "已收藏版本",
                        )
                      }
                    >
                      <PixelFrame />
                      <Star
                        size={17}
                        fill={v.favorite ? "currentColor" : "none"}
                      />
                    </button>
                    <button
                      type="button"
                      className="icon-button has-surface"
                      data-tooltip="本地资源"
                      aria-label={`查看 ${v.id} 本地资源`}
                      onClick={() => app.openVersionPage("resources", v)}
                    >
                      <PixelFrame />
                      <FolderOpen size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-button has-surface"
                      data-tooltip={`游戏设置 · ${v.independentSettings ? "独立" : "全局"}`}
                      aria-label={`游戏设置 ${v.id}`}
                      onClick={() => app.openVersionPage("settings", v)}
                    >
                      <PixelFrame />
                      <Settings2 size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-button has-surface"
                      data-tooltip="更多操作"
                      aria-label={`管理 ${v.id}`}
                      aria-haspopup="dialog"
                      onClick={() => {
                        setDetail(v);
                      }}
                    >
                      <PixelFrame />
                      <MoreHorizontal size={18} />
                    </button>
                  </div>
                  {v.error && <p className="inline-error">{v.error}</p>}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
      {detail && (
        <VersionManageDialog
          key={detail.path}
          version={detail}
          onClose={() => setDetail(null)}
        />
      )}
      {importPack && (
        <ModpackInstallDialog
          onClose={() => {
            app.clearError();
            setImportPack(false);
          }}
        />
      )}
    </div>
  );
}
