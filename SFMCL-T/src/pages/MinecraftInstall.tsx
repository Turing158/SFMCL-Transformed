import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Empty, PixelFrame, TabList } from "../components";
import { api } from "../api";
import { matchesVersionFilter } from "../installOptions";
import type { ManifestVersion } from "../types";
import { CatalogView, type ResourceView } from "./CatalogView";
import { CatalogItems, CatalogSkeleton } from "./CatalogMotion";
import { useTabContentTransition } from "../useTabContentTransition";
import { MinecraftTypeIcon } from "./MinecraftTypeIcon";

const versionTypes = [
  { value: "release", label: "正式版" },
  { value: "snapshot", label: "快照版" },
  { value: "april", label: "愚人节" },
  { value: "old", label: "历史版" },
  { value: "all", label: "全部" },
];
const pageSize = 20;

export function MinecraftInstall({
  query,
  view,
  onViewChange,
  onSelect,
}: {
  query: string;
  view: ResourceView;
  onViewChange: (view: ResourceView) => void;
  onSelect: (version: ManifestVersion) => void;
}) {
  const [versions, setVersions] = useState<ManifestVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("release");
  const [page, setPage] = useState(0);
  const results = useTabContentTransition(
    versionTypes.findIndex((type) => type.value === filter),
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api<{ versions: ManifestVersion[] }>("manifest")
      .then((value) => {
        if (active) setVersions(value.versions);
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
  }, [revision]);
  useEffect(() => {
    setPage(0);
  }, [query, filter]);
  const list = versions
    .filter(
      (version) =>
        matchesVersionFilter(version, filter) &&
        version.id.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const goToPage = (value: number) => {
    setPage(value);
    results.current?.scrollIntoView({ block: "start" });
  };

  return (
    <section
      className="minecraft-install catalog-layout"
      aria-label="安装 Minecraft"
    >
      <div className="minecraft-catalog-toolbar">
        <TabList
          id="minecraft-version-types"
          label="Minecraft 版本类型"
          className="minecraft-version-tabs compact"
          value={filter}
          onValueChange={setFilter}
          items={versionTypes}
        />
        <CatalogView value={view} onValueChange={onViewChange} />
      </div>
      <div
        id="minecraft-version-types-panel"
        className="catalog-results tab-panel"
        ref={results}
        role="tabpanel"
        aria-labelledby={`minecraft-version-types-tab-${filter}`}
        aria-busy={loading}
        tabIndex={0}
      >
        {error ? (
          <section className="panel has-surface" role="alert">
            <PixelFrame />
            <Empty
              title="暂时无法获取版本"
              description={error}
              action={
                <Button onClick={() => setRevision((value) => value + 1)}>
                  <RefreshCw size={16} />
                  重新获取列表
                </Button>
              }
            />
          </section>
        ) : loading ? (
          <CatalogSkeleton view={view} label="正在加载版本" />
        ) : list.length ? (
          <>
            <CatalogItems
              view={view}
              revision={`${filter}:${query}:${currentPage}`}
            >
              {list
                .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                .map((version) => (
                  <article
                    key={version.id}
                    className="catalog-project has-surface"
                  >
                    <PixelFrame />
                    <button
                      className="catalog-project-info"
                      aria-label={`查看 Minecraft ${version.id} 安装配置`}
                      onClick={() => onSelect(version)}
                    >
                      <MinecraftTypeIcon version={version} />
                      <div className="catalog-project-copy">
                        <div className="catalog-project-title">
                          <h2>{version.id}</h2>
                          <span>Mojang</span>
                        </div>
                        <p>发布于 {version.releaseTime.slice(0, 10)}</p>
                      </div>
                    </button>
                    <div className="catalog-project-footer">
                      <div className="catalog-tags">
                        <Badge>
                          {versionTypes.find(
                            (type) =>
                              type.value !== "all" &&
                              matchesVersionFilter(version, type.value),
                          )?.label || version.type}
                        </Badge>
                        <Badge>Java 版</Badge>
                      </div>
                    </div>
                  </article>
                ))}
            </CatalogItems>
            <nav
              className="pagination catalog-pagination"
              aria-label="Minecraft 版本分页"
            >
              <Button
                disabled={currentPage === 0}
                onClick={() => goToPage(currentPage - 1)}
              >
                上一页
              </Button>
              <span
                className="page-indicator catalog-page-indicator has-surface"
                tabIndex={0}
              >
                <PixelFrame />
                <span className="page-indicator-text">
                  第 {currentPage + 1} / {pages} 页
                </span>
              </span>
              <Button
                disabled={currentPage + 1 >= pages}
                onClick={() => goToPage(currentPage + 1)}
              >
                下一页
              </Button>
            </nav>
          </>
        ) : (
          <section className="panel has-surface">
            <PixelFrame />
            <Empty
              title="没有找到匹配版本"
              description="试试其他关键词或版本类型。"
            />
          </section>
        )}
      </div>
    </section>
  );
}
