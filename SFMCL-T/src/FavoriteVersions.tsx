import { useId, useLayoutEffect, useRef, useState } from "react";
import { PixelFrame, ResourceImage } from "./components";
import { useApp } from "./store";
import { versionIcon } from "./versionIcon";
import { FavoriteScrollbar } from "./FavoriteScrollbar";
import {
  VersionContextMenu,
  useVersionContextMenu,
} from "./VersionContextMenu";

export function FavoriteVersions({ collapsed }: { collapsed: boolean }) {
  const app = useApp();
  const list = useRef<HTMLOListElement>(null);
  const listId = useId();
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const versions = [...app.favorites].reverse();
  const versionKeys = versions.map((version) => version.path).join("\n");
  const versionMenu = useVersionContextMenu(
    JSON.stringify([collapsed, versionKeys]),
  );
  const { menu, openMenu, activate, pending, locked } = versionMenu;

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
                data-window-drag="false"
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
      <VersionContextMenu state={versionMenu} />
    </div>
  );
}
