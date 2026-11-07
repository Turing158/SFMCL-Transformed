import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  FolderOpen,
  MoreHorizontal,
  Play,
  Settings2,
  Star,
} from "lucide-react";
import { api } from "./api";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuAnchor, ContextMenuEntry } from "./ContextMenu";
import { getLaunchTask } from "./launchState";
import { useApp } from "./store";
import type { Version } from "./types";
import { versionPayload } from "./versionActions";
import { VersionManageDialog } from "./VersionManageDialog";

type VersionAction = {
  id: string;
  directory: string;
  path: string;
  launch: boolean;
  phase: "selecting" | "launching";
  jobId?: string;
};

export function useVersionContextMenu(revision: string) {
  const app = useApp();
  const current = useRef(app);
  current.current = app;
  const action = useRef<VersionAction | null>(null);
  const [pending, setPending] = useState<VersionAction | null>(null);
  const [menu, setMenu] = useState<{
    version: Version;
    anchor: ContextMenuAnchor;
    key: number;
  } | null>(null);
  const [managed, setManaged] = useState<Version | null>(null);
  const menuKey = useRef(0);
  const locked = getLaunchTask(
    app.tasks,
    app.data.settings.activeVersion,
  ).active;

  useEffect(() => {
    setMenu(null);
  }, [app.route, revision]);

  function openMenu(
    version: Version,
    element: HTMLElement,
    x: number,
    y: number,
  ) {
    if (document.querySelector("dialog[open]")) return;
    setMenu({ version, anchor: { element, x, y }, key: ++menuKey.current });
  }

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
    version: Version,
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
    const directory = version.directory ?? app.data.settings.activeDir;
    const selected =
      app.data.settings.activeDir === directory &&
      app.data.settings.activeVersion === version.id;
    if (selected && mode === "select") {
      app.notify(`当前已选择 ${version.id}`);
      return;
    }
    const next: VersionAction = {
      id: version.id,
      directory,
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
            directory,
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

  return {
    menu,
    closeMenu: () => setMenu(null),
    openMenu,
    managed,
    setManaged,
    activate,
    pending,
    locked,
  };
}

export function VersionContextMenu({
  state,
}: {
  state: ReturnType<typeof useVersionContextMenu>;
}) {
  const app = useApp();
  const { menu, closeMenu, managed, setManaged, activate, pending, locked } =
    state;
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
          id: target.favorite ? "unfavorite" : "favorite",
          label: target.favorite ? "取消收藏" : "收藏版本",
          icon: (
            <Star
              size={16}
              fill={target.favorite ? "currentColor" : "none"}
              aria-hidden="true"
            />
          ),
          disabled: app.busy,
          onSelect: () =>
            void app.mutate(
              "versions.favorite",
              versionPayload(target, { favorite: !target.favorite }),
              target.favorite ? "已取消收藏" : "已收藏版本",
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
    <>
      {menu && (
        <ContextMenu
          key={menu.key}
          anchor={menu.anchor}
          title={menu.version.id}
          showHeading={false}
          className="favorite-context-menu"
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {managed && (
        <VersionManageDialog
          key={managed.path}
          version={managed}
          onClose={() => setManaged(null)}
        />
      )}
    </>
  );
}
