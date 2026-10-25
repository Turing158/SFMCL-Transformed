import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Box,
  ChevronDown,
  Compass,
  Download,
  Gamepad2,
  Layers,
  Package,
  Search,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import { Input, SearchField, Select } from "../controls";
import {
  Badge,
  Button,
  Empty,
  PixelFrame,
  ResourceImage,
  TabList,
  TabPanel,
} from "../components";
import { api } from "../api";
import { PageTitle } from "../PageHeader";
import { ProjectPage } from "./ProjectPage";
import { MinecraftInstallPage } from "./MinecraftInstallPage";
import { MinecraftInstall } from "./MinecraftInstall";
import { CatalogView, type ResourceView } from "./CatalogView";
import {
  CatalogItems,
  CatalogResultCount,
  CatalogSkeleton,
} from "./CatalogMotion";
import { useApp } from "../store";
import { usePageActive } from "../PageActivity";
import { useTabContentTransition } from "../useTabContentTransition";
import type { ResourcePage, ResourceTab } from "../navigation";
import type { Project } from "../types";

const kinds = [
  { id: "mod", label: "模组", icon: Box },
  { id: "resourcepack", label: "材质包", icon: Layers },
  { id: "shader", label: "光影", icon: Sun },
  { id: "datapack", label: "数据包", icon: Package },
  { id: "modpack", label: "整合包", icon: Package },
] as const;
const viewKey = "sfmcl-t.resources.view";
const pageSize = 20;
const initialFilters = {
  source: "modrinth",
  query: "",
  gameVersion: "",
  loader: "",
  category: "",
  sort: "relevance",
  offset: 0,
};

function ProjectDownloads({ count }: { count: number }) {
  return (
    <span
      className="catalog-downloads"
      data-tooltip={`${count.toLocaleString()} 次下载`}
    >
      <Download size={14} />
      {Intl.NumberFormat("zh-CN", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(count)}
    </span>
  );
}

export function Resources() {
  const app = useApp();
  const pageActive = usePageActive();
  const tab =
    app.route.page === "resources"
      ? (app.route.tab ?? "minecraft")
      : "minecraft";
  const isMinecraft = tab === "minecraft";
  const [filters, setFilters] = useState(initialFilters);
  const [query, setQuery] = useState("");
  const [minecraftQuery, setMinecraftQuery] = useState("");
  const [versionInput, setVersionInput] = useState("");
  const [view, setView] = useState<ResourceView>(() => {
    try {
      return localStorage.getItem(viewKey) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [categoryError, setCategoryError] = useState("");
  const [categoryRetry, setCategoryRetry] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const detail =
    app.route.page === "resources" ? app.route.resource : undefined;
  const catalogContent = useTabContentTransition(
    ["minecraft", ...kinds.map((kind) => kind.id)].indexOf(tab),
    !detail,
  );
  const root = useRef<HTMLElement>(null);
  const previousDetail = useRef(detail);
  const returnPosition = useRef<{
    tab: ResourceTab;
    scrollTop: number;
    trigger: Element | null;
  } | null>(null);
  const openDetail = (resource: ResourcePage) => {
    returnPosition.current = {
      tab,
      scrollTop: root.current?.closest<HTMLElement>(".page")?.scrollTop ?? 0,
      trigger: document.activeElement,
    };
    app.clearError();
    app.navigate({ page: "resources", tab, resource });
  };
  const backToList = () => app.openResources(tab);
  useLayoutEffect(() => {
    const page = root.current?.closest<HTMLElement>(".page");
    if (detail && page) page.scrollTop = 0;
    else if (previousDetail.current && page) {
      const saved = returnPosition.current;
      page.scrollTop = saved?.tab === tab ? saved.scrollTop : 0;
      if (
        saved?.tab === tab &&
        saved.trigger instanceof HTMLElement &&
        saved.trigger.isConnected
      )
        saved.trigger.focus({ preventScroll: true });
      app.clearError();
      returnPosition.current = null;
    }
    previousDetail.current = detail;
  }, [detail, tab]);
  const searchForm = useRef<HTMLFormElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const kindLabel = kinds.find((item) => item.id === tab)?.label || "资源";
  const filterCount = [
    filters.gameVersion,
    filters.loader,
    filters.category,
  ].filter(Boolean).length;
  const changeFilters = (change: Partial<typeof filters>) =>
    setFilters((current) => ({ ...current, ...change, offset: 0 }));
  const changeTab = (value: string) => {
    const next = value as ResourceTab;
    app.openResources(next);
    if (next === tab) return;
    if (next !== "minecraft") {
      changeFilters({
        category: "",
        loader: next === "mod" || next === "modpack" ? filters.loader : "",
      });
    }
  };
  const resetFilters = () => {
    setVersionInput("");
    changeFilters({ gameVersion: "", loader: "", category: "" });
  };
  const submitSearch = () => {
    changeFilters({ query: query.trim(), gameVersion: versionInput.trim() });
    setRetry((value) => value + 1);
  };

  useEffect(() => {
    try {
      localStorage.setItem(viewKey, view);
    } catch {
      /* Storage can be unavailable in restricted webviews. */
    }
  }, [view]);
  useEffect(() => {
    if (!pageActive) return;
    const handleKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !detail &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        searchForm.current?.querySelector("input")?.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [detail, pageActive]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const value = versionInput.trim();
      setFilters((current) =>
        current.gameVersion === value
          ? current
          : { ...current, gameVersion: value, offset: 0 },
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [versionInput]);
  useEffect(() => {
    if (isMinecraft) return;
    let active = true;
    setCategories([]);
    setCategoryError("");
    void api<{ id: string; name: string }[]>("resources.categories", {
      source: filters.source,
      kind: tab,
    })
      .then((items) => {
        if (active) setCategories(items);
      })
      .catch(() => {
        if (active) setCategoryError("分类加载失败");
      });
    return () => {
      active = false;
    };
  }, [filters.source, tab, isMinecraft, categoryRetry]);
  useEffect(() => {
    if (isMinecraft) return;
    let active = true;
    setLoading(true);
    setError("");
    setProjects([]);
    void api<{ items: Project[]; total: number }>("resources.search", {
      ...filters,
      kind: tab,
      limit: pageSize,
    })
      .then((result) => {
        if (active) {
          setProjects(result.items);
          setTotal(result.total);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(String(reason));
          setTotal(0);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, tab, isMinecraft, retry]);

  return (
    <section ref={root} className="resource-center" aria-label="资源中心">
      <header className="catalog-header" hidden={!!detail}>
        <PageTitle
          icon={<Compass />}
          title="资源中心"
          eyebrow="RESOURCE CENTER"
        />
        <form
          hidden={!!detail}
          ref={searchForm}
          className="catalog-search has-surface"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (isMinecraft) setMinecraftQuery(minecraftQuery.trim());
            else submitSearch();
          }}
        >
          <PixelFrame />
          <SearchField
            label={isMinecraft ? "搜索可安装版本" : "搜索资源"}
            placeholder={
              isMinecraft ? "搜索 Minecraft 版本…" : `搜索${kindLabel}…`
            }
            value={isMinecraft ? minecraftQuery : query}
            onValueChange={(value) => {
              if (isMinecraft) setMinecraftQuery(value);
              else {
                setQuery(value);
                if (!value) changeFilters({ query: "" });
              }
            }}
            loading={!isMinecraft && loading}
          />
          {!(isMinecraft ? minecraftQuery : query) && (
            <kbd className="catalog-shortcut">Ctrl K</kbd>
          )}
          <button
            type="submit"
            className="catalog-search-submit"
            aria-label="搜索"
            data-tooltip="搜索 · Enter"
          >
            <ArrowRight size={18} />
          </button>
        </form>
        <div
          className={`catalog-source ${isMinecraft ? "minecraft-source has-surface" : ""}`}
          hidden={!!detail}
        >
          {isMinecraft && <PixelFrame />}
          <ResourceImage
            path={`/assets/DefaultGameIcon/${isMinecraft ? "Minecraft" : filters.source === "modrinth" ? "modrinth" : "curseForge"}.png`}
            alt=""
          />
          {isMinecraft ? (
            <span>官方版本</span>
          ) : (
            <Select
              aria-label="资源来源"
              value={filters.source}
              onValueChange={(source) =>
                changeFilters({ source, category: "" })
              }
            >
              <option value="modrinth">Modrinth</option>
              <option value="curseforge">CurseForge</option>
            </Select>
          )}
        </div>
      </header>
      <div hidden={!!detail}>
        <TabList
          id="resource-center"
          label="资源中心分类"
          className="resource-center-tabs"
          value={tab}
          onValueChange={changeTab}
          items={[
            {
              value: "minecraft",
              label: "Minecraft",
              icon: <Gamepad2 size={17} />,
            },
            ...kinds.map(({ id, label, icon: Icon }) => ({
              value: id,
              label,
              icon: <Icon size={17} />,
            })),
          ]}
        />
      </div>
      <TabPanel
        id="resource-center"
        value={tab}
        className="resource-center-content"
      >
        <div
          ref={catalogContent}
          className="resource-catalog"
          hidden={!!detail}
        >
          {isMinecraft ? (
            <MinecraftInstall
              query={minecraftQuery}
              view={view}
              onViewChange={setView}
              onSelect={(version) => openDetail({ kind: "minecraft", version })}
            />
          ) : (
            <div className="catalog-layout">
              <div className="catalog-sidebar has-surface">
                <PixelFrame />
                <div className="catalog-toolbar">
                  <CatalogResultCount
                    text={
                      loading ? "搜索中…" : `${total.toLocaleString()} 个结果`
                    }
                  />
                  <div className="catalog-actions">
                    <button
                      ref={filterButton}
                      className="catalog-filter-toggle"
                      aria-expanded={filtersOpen}
                      aria-controls="catalog-filters"
                      onClick={() => setFiltersOpen(!filtersOpen)}
                    >
                      <SlidersHorizontal size={16} aria-hidden="true" />
                      筛选{filterCount > 0 && <Badge>{filterCount}</Badge>}
                      <ChevronDown
                        className="catalog-filter-chevron"
                        size={14}
                        aria-hidden="true"
                      />
                    </button>
                    <Select
                      className="catalog-sort"
                      aria-label="资源排序"
                      value={filters.sort}
                      onValueChange={(sort) => changeFilters({ sort })}
                    >
                      <option value="relevance">推荐排序</option>
                      <option value="downloads">下载最多</option>
                      <option value="updated">最近更新</option>
                    </Select>
                    <CatalogView value={view} onValueChange={setView} />
                  </div>
                </div>
                <aside
                  id="catalog-filters"
                  className={`catalog-filters ${filtersOpen ? "is-open" : ""}`}
                  aria-label="资源筛选"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" &&
                      !event.defaultPrevented &&
                      filterButton.current?.getClientRects().length
                    ) {
                      setFiltersOpen(false);
                      filterButton.current.focus();
                    }
                  }}
                >
                  <div className="catalog-filters-clip">
                    <div className="catalog-filter-panel has-surface">
                      <PixelFrame />
                      <form
                        className="catalog-filter-fields"
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitSearch();
                        }}
                      >
                        <label>
                          游戏版本
                          <Input
                            placeholder="全部版本"
                            value={versionInput}
                            onChange={(event) =>
                              setVersionInput(event.target.value)
                            }
                          />
                        </label>
                        {(tab === "mod" || tab === "modpack") && (
                          <label>
                            加载器
                            <Select
                              value={filters.loader}
                              onValueChange={(loader) =>
                                changeFilters({ loader })
                              }
                            >
                              <option value="">全部加载器</option>
                              {[
                                "Fabric",
                                "Forge",
                                "NeoForge",
                                "Quilt",
                                "LiteLoader",
                              ].map((loader) => (
                                <option key={loader}>{loader}</option>
                              ))}
                            </Select>
                          </label>
                        )}
                        <label>
                          分类
                          <Select
                            value={filters.category}
                            onValueChange={(category) =>
                              changeFilters({ category })
                            }
                          >
                            <option value="">全部分类</option>
                            {categories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <button
                          type="button"
                          className="catalog-reset"
                          disabled={!filterCount && !versionInput}
                          onClick={resetFilters}
                        >
                          重置筛选
                        </button>
                        {categoryError && (
                          <button
                            type="button"
                            className="catalog-category-error"
                            onClick={() =>
                              setCategoryRetry((value) => value + 1)
                            }
                          >
                            {categoryError}，重试
                          </button>
                        )}
                      </form>
                    </div>
                  </div>
                </aside>
              </div>
              <div
                className="catalog-results"
                ref={resultsRef}
                aria-busy={loading}
              >
                {filterCount > 0 && (
                  <div className="catalog-active-filters" aria-label="已选筛选">
                    {filters.gameVersion && (
                      <button
                        onClick={() => {
                          setVersionInput("");
                          changeFilters({ gameVersion: "" });
                        }}
                        aria-label={`移除版本筛选 ${filters.gameVersion}`}
                      >
                        {filters.gameVersion}
                        <X size={13} />
                      </button>
                    )}
                    {filters.loader && (
                      <button
                        onClick={() => changeFilters({ loader: "" })}
                        aria-label={`移除加载器筛选 ${filters.loader}`}
                      >
                        {filters.loader}
                        <X size={13} />
                      </button>
                    )}
                    {filters.category && (
                      <button
                        onClick={() => changeFilters({ category: "" })}
                        aria-label="移除分类筛选"
                      >
                        {categories.find(
                          (category) => category.id === filters.category,
                        )?.name || filters.category}
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )}
                {error ? (
                  <section className="panel has-surface">
                    <PixelFrame />
                    <Empty
                      title="暂时无法获取资源"
                      description={error}
                      action={
                        <Button onClick={() => setRetry((value) => value + 1)}>
                          重试
                        </Button>
                      }
                    />
                  </section>
                ) : loading ? (
                  <CatalogSkeleton view={view} label="正在加载资源" />
                ) : projects.length ? (
                  <>
                    <CatalogItems view={view} revision={projects}>
                      {projects.map((project) => (
                        <article
                          key={`${project.source}-${project.id}`}
                          className="catalog-project has-surface"
                        >
                          <PixelFrame />
                          <button
                            className="catalog-project-info"
                            aria-label={`查看 ${project.title} 详情`}
                            onClick={() =>
                              openDetail({
                                kind: "project",
                                project,
                                initialTab: "description",
                                gameVersion: filters.gameVersion,
                                loader: filters.loader,
                              })
                            }
                          >
                            <ResourceImage path={project.icon} alt="" />
                            <div className="catalog-project-copy">
                              <div className="catalog-project-title">
                                <h2>{project.title}</h2>
                                <span>{project.author}</span>
                              </div>
                              <p>{project.description}</p>
                              <div className="catalog-project-meta">
                                <div className="catalog-tags">
                                  {project.categories
                                    .slice(0, 3)
                                    .map((category) => (
                                      <Badge key={category}>{category}</Badge>
                                    ))}
                                </div>
                                <ProjectDownloads count={project.downloads} />
                              </div>
                            </div>
                          </button>
                        </article>
                      ))}
                    </CatalogItems>
                    <nav
                      className="pagination catalog-pagination"
                      aria-label="资源分页"
                    >
                      <Button
                        disabled={filters.offset === 0}
                        onClick={() => {
                          setFilters((current) => ({
                            ...current,
                            offset: Math.max(0, current.offset - pageSize),
                          }));
                          resultsRef.current?.scrollIntoView({
                            block: "start",
                          });
                        }}
                      >
                        上一页
                      </Button>
                      <span
                        className="page-indicator catalog-page-indicator has-surface"
                        tabIndex={0}
                      >
                        <PixelFrame />
                        <span className="page-indicator-text">
                          第 {Math.floor(filters.offset / pageSize) + 1} /{" "}
                          {Math.max(1, Math.ceil(total / pageSize))} 页
                        </span>
                      </span>
                      <Button
                        disabled={filters.offset + pageSize >= total}
                        onClick={() => {
                          setFilters((current) => ({
                            ...current,
                            offset: current.offset + pageSize,
                          }));
                          resultsRef.current?.scrollIntoView({
                            block: "start",
                          });
                        }}
                      >
                        下一页
                      </Button>
                    </nav>
                  </>
                ) : (
                  <section className="panel has-surface">
                    <PixelFrame />
                    <Empty
                      title="没有找到匹配资源"
                      description="试试其他关键词，或减少筛选条件。"
                      action={
                        <Button
                          onClick={() => {
                            setQuery("");
                            setVersionInput("");
                            changeFilters({
                              query: "",
                              gameVersion: "",
                              loader: "",
                              category: "",
                            });
                          }}
                        >
                          <Search size={16} />
                          浏览全部{kindLabel}
                        </Button>
                      }
                    />
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
        {detail?.kind === "minecraft" && (
          <MinecraftInstallPage
            key={detail.version.id}
            version={detail.version}
            onBack={backToList}
          />
        )}
        {detail?.kind === "project" && tab !== "minecraft" && (
          <ProjectPage
            key={`${tab}:${detail.project.source}:${detail.project.id}:${detail.gameVersion}:${detail.loader}`}
            project={detail.project}
            kind={tab}
            gameVersion={detail.gameVersion}
            loader={detail.loader}
            view={view}
            onViewChange={setView}
            initialTab={detail.initialTab}
          />
        )}
      </TabPanel>
    </section>
  );
}
