import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  FolderOpen,
  MoreHorizontal,
  Play,
  Settings2,
  Star,
} from "lucide-react";
import { api } from "./api";
import { PixelFrame, ResourceImage } from "./components";
import { getLaunchTask } from "./launchState";
import { useApp } from "./store";
import type { FavoriteVersion } from "./types";
import { versionIcon } from "./versionIcon";
import { FavoriteScrollbar } from "./FavoriteScrollbar";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuAnchor, ContextMenuEntry } from "./ContextMenu";
import { VersionManageDialog } from "./VersionManageDialog";
import { versionPayload } from "./versionActions";

type FavoriteAction = {
  id: string;
  directory: string;
  path: string;
  launch: boolean;
  phase: "selecting" | "launching";
  jobId?: string;
};

export function FavoriteVersions({ collapsed }: { collapsed: boolean }) {
  const app = useApp();
  const current = useRef(app);
  current.current = app;
  const action = useRef<FavoriteAction | null>(null);
  const [pending, setPending] = useState<FavoriteAction | null>(null);
  const [menu, setMenu] = useState<{
    version: FavoriteVersion;
    anchor: ContextMenuAnchor;
    key: number;
  } | null>(null);
  const [managed, setManaged] = useState<FavoriteVersion | null>(null);
  const menuKey = useRef(0);
  const list = useRef<HTMLOListElement>(null);
  const listId = useId();
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const versions = [...app.favorites].reverse();
  const versionKeys = versions.map((version) => version.path).join("\n");
  const locked = getLaunchTask(
    app.tasks,
    app.data.settings.activeVersion,
  ).active;

  useEffect(() => {
    setMenu(null);
  }, [app.route, collapsed, versionKeys]);

  function openMenu(
    version: FavoriteVersion,
    element: HTMLElement,
    x: number,
    y: number,
  ) {
    if (document.querySelector("dialog[open]")) return;
    setMenu({ version, anchor: { element, x, y }, key: ++menuKey.current });
  }

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    // The first favorite is at the bottom, including when the list overflows.
    element.scrollTop = element.scrollHeight;
    const measure = () => {
      const remaining = element.scrollHeight - element.clientHeight;
      const next = {
        top: element.scrollTop > 1,
        bottom: remaining - element.scrollTop > 1,
      };
      setScrollEdges((previous) =>
        previous.top === next.top && previous.bottom === next.bottom
          ? previous
          : next,
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Keep the edge fades in sync with wrapped names and rail resizing.
    Array.from(element.children).forEach((item) => observer.observe(item));
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [versionKeys]);

  useEffect(() => {
    if (
      pending?.jobId &&
      app.tasks.jobs.some((job) => job.id === pending.jobId)
    ) {
      action.current = null;
      setPending(null);
    }
  }, [app.tasks, pending]);

  async function activate(
    version: FavoriteVersion,
    detail: number,
    mode: "auto" | "launch" | "select" = "auto",
  ) {
    if (locked || version.error) return;
    if (action.current) {
      // A second click may arrive while the persisted selection is still pending.
      // Queue launch on that selection instead of losing the double click.
      if (
        mode !== "select" &&
        action.current.path === version.path &&
        action.current.phase === "selecting"
      )
        action.current.launch = true;
      return;
    }
    if (app.busy) return;
    const selected =
      app.data.settings.activeDir === version.directory &&
      app.data.settings.activeVersion === version.id;
    if (selected && mode === "select") {
      app.notify(`当前已选择 ${version.id}`);
      return;
    }
    const next: FavoriteAction = {
      id: version.id,
      directory: version.directory,
      path: version.path,
      launch:
        mode === "launch" || (mode === "auto" && (selected || detail > 1)),
      phase: selected ? "launching" : "selecting",
    };
    action.current = next;
    setPending({ ...next });
    try {
      await app.run(async () => {
        if (!selected)
          await app.update("versions.select", {
            id: version.id,
            directory: version.directory,
          });
        if (!next.launch) {
          app.notify(`已切换到 ${version.id}`);
          return;
        }
        const latest = current.current;
        if (
          !latest.data.players.some(
            (player) => player.uuid === latest.data.settings.activePlayer,
          )
        )
          throw new Error("请先选择一个角色，再启动游戏");
        if (getLaunchTask(latest.tasks, version.id).active) return;
        next.phase = "launching";
        setPending({ ...next });
        next.jobId = await api<string>("launch", {
          id: next.id,
          directory: next.directory,
        });
        setPending({ ...next });
        app.notify(`正在启动 ${version.id}`);
      });
    } finally {
      // Keep the launch guard until polling publishes the newly created job.
      if (!next.jobId) {
        action.current = null;
        setPending(null);
      }
    }
  }

  const target = menu?.version;
  const unavailable = app.busy || !!pending || locked || !!target?.error;
  const menuItems: ContextMenuEntry[] = target
    ? [
        {
          id: "launch",
          label: "启动版本",
          icon: <Play size={16} fill="currentColor" aria-hidden="true" />,
          disabled: unavailable,
          onSelect: () => void activate(target, 0, "launch"),
        },
        {
          id: "select",
          label: "切换版本",
          icon: <ArrowRightLeft size={16} aria-hidden="true" />,
          disabled: unavailable,
          onSelect: () => void activate(target, 0, "select"),
        },
        { separator: true },
        {
          id: "resources",
          label: "查看资源",
          icon: <FolderOpen size={16} aria-hidden="true" />,
          disabled: app.busy,
          onSelect: () => app.openVersionPage("resources", target),
        },
        {
          id: "settings",
          label: "版本设置",
          icon: <Settings2 size={16} aria-hidden="true" />,
          disabled: app.busy,
          onSelect: () => app.openVersionPage("settings", target),
        },
        { separator: true },
        {
          id: "unfavorite",
          label: "取消收藏",
          icon: <Star size={16} fill="currentColor" aria-hidden="true" />,
          disabled: app.busy,
          onSelect: () =>
            void app.mutate(
              "versions.favorite",
              versionPayload(target, { favorite: false }),
              "已取消收藏",
            ),
        },
        {
          id: "more",
          label: "更多",
          icon: <MoreHorizontal size={16} aria-hidden="true" />,
          hasPopup: "dialog",
          disabled: app.busy,
          onSelect: () => setManaged(target),
        },
      ]
    : [];

  return (
    <div className="sidebar-favorites-space">
      <div
        className="sidebar-favorites-viewport"
        data-scroll-top={scrollEdges.top || undefined}
        data-scroll-bottom={scrollEdges.bottom || undefined}
      >
        <ol
          ref={list}
          id={listId}
          className="sidebar-favorites"
          aria-label="收藏版本"
        >
          {versions.map((version) => {
            const selected =
              app.data.settings.activeDir === version.directory &&
              app.data.settings.activeVersion === version.id;
            const selecting =
              pending?.path === version.path && pending.phase === "selecting";
            return (
              <li
                key={version.path}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const element = event.currentTarget.querySelector("button")!;
                  const rect = element.getBoundingClientRect();
                  openMenu(
                    version,
                    element,
                    event.clientX || rect.right,
                    event.clientY || rect.top,
                  );
                }}
              >
                <button
                  type="button"
                  className={`sidebar-favorite has-surface${selected ? " active" : ""}`}
                  aria-label={`收藏版本：${version.id}`}
                  aria-pressed={selected}
                  aria-busy={pending?.path === version.path || undefined}
                  aria-haspopup="menu"
                  aria-expanded={menu?.version.path === version.path}
                  data-directory={version.directory}
                  disabled={
                    locked ||
                    !!version.error ||
                    (!!pending && !selecting) ||
                    (app.busy && !selecting)
                  }
                  data-tooltip={
                    version.error ||
                    `${version.id} · ${version.directoryName}\n${version.directory}\n${selected ? "点击启动" : "点击切换，双击启动"}`
                  }
                  data-tooltip-placement="right"
                  onClick={(event) => void activate(version, event.detail)}
                  onDoubleClick={() => void activate(version, 2)}
                  onKeyDown={(event) => {
                    if (
                      (event.shiftKey && event.key === "F10") ||
                      event.key === "ContextMenu"
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openMenu(
                        version,
                        event.currentTarget,
                        rect.right,
                        rect.top,
                      );
                    }
                  }}
                >
                  <PixelFrame />
                  <span className="sidebar-favorite-icon" aria-hidden="true">
                    <ResourceImage path={versionIcon(version)} alt="" />
                  </span>
                  <span
                    className="sidebar-favorite-copy"
                    aria-hidden={collapsed || undefined}
                  >
                    {version.id}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <FavoriteScrollbar
          list={list}
          listId={listId}
          contentKey={versionKeys}
        />
      </div>
      {menu && (
        <ContextMenu
          key={menu.key}
          anchor={menu.anchor}
          title={menu.version.id}
          showHeading={false}
          className="favorite-context-menu"
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {managed && (
        <VersionManageDialog
          key={managed.path}
          version={managed}
          onClose={() => setManaged(null)}
        />
      )}
    </div>
  );
}
