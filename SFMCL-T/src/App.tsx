import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Box,
  ChevronLeft,
  ChevronRight,
  Compass,
  House,
  Leaf,
  Play,
  Settings2,
} from "lucide-react";
import { PageRouteProvider, useApp } from "./store";
import { desktop, statusLabel } from "./api";
import { Skin, useImage, PixelFrame } from "./components";
import { Players } from "./pages/Players";
import { Versions } from "./pages/Versions";
import { Resources } from "./pages/Resources";
import { Downloads } from "./pages/Downloads";
import { SettingsPage } from "./pages/Settings";
import { NoticeRefreshButton, Notices, useNotices } from "./Notices";
import { Titlebar } from "./Titlebar";
import { LaunchDock } from "./LaunchDock";
import { FavoriteVersions } from "./FavoriteVersions";
import { WorkspaceFooter } from "./WorkspaceFooter";
import { FooterText } from "./FooterText";
import { FooterStatusIcon } from "./FooterStatusIcon";
import { NotificationDeck } from "./NotificationDeck";
import { ModpackDropTarget } from "./ModpackDropTarget";
import { navigationPage, pageNames, pageViews } from "./navigation";
import { useNavigationTransition } from "./useNavigationTransition";
import { usePlayerCaption } from "./usePlayerCaption";
import { appIcon } from "./branding";
import { BrandWordmark } from "./BrandWordmark";
import { PageHeader } from "./PageHeader";
import { PageActivity } from "./PageActivity";
import { SidebarProgress, useSidebarProgress } from "./SidebarProgress";
const navigation = [
  { id: "home", name: pageNames.home, icon: House },
  { id: "versions", name: pageNames.versions, icon: Box },
  { id: "resources", name: pageNames.resources, icon: Compass },
  { id: "settings", name: pageNames.settings, icon: Settings2 },
] as const;
const pages = {
  home: Home,
  players: Players,
  versions: Versions,
  resources: Resources,
  downloads: Downloads,
  settings: SettingsPage,
};
export default function App() {
  const app = useApp();
  const { workspace, pageKey } = useNavigationTransition(app.route);
  const [collapsed, setCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 850px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 850px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const railCollapsed = collapsed || narrow;
  const player = app.data.players.find(
    (p) => p.uuid === app.data.settings.activePlayer,
  );
  const playerCaption = usePlayerCaption(pageKey, player?.name);
  const active = app.tasks.downloads.filter(
    (d) => d.status === "running",
  ).length;
  const sidebarProgress = useSidebarProgress(
    app.tasks,
    ["always", "active"].includes(app.data.settings.downloadTaskDisplay),
  );
  const showDownloadTasks =
    app.data.settings.downloadTaskDisplay === "always" ||
    (app.data.settings.downloadTaskDisplay === "active" &&
      (sidebarProgress.active || sidebarProgress.present));
  const download =
    app.tasks.downloads.find((d) => d.status === "running") ??
    app.tasks.downloads.find((d) => ["pausing", "queued"].includes(d.status)) ??
    app.tasks.downloads.find((d) => ["failed", "paused"].includes(d.status)) ??
    app.tasks.downloads[0];
  const task =
    (sidebarProgress.active || sidebarProgress.present
      ? sidebarProgress.info
      : undefined) ?? download;
  const progress = sidebarProgress.present
    ? sidebarProgress.info?.value
    : undefined;
  const downloadTitle = task?.title || "暂无下载任务";
  const background = useImage(
    app.data.backgroundPath ||
      (["none", "default"].includes(app.data.settings.backgroundType)
        ? ""
        : app.data.settings.background),
  );
  return (
    <div
      className={`app ${collapsed ? "collapsed" : ""} ${app.page === "home" ? "has-launch-dock" : ""}`}
      onDragStartCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("img, canvas")
        ) {
          event.preventDefault();
        }
      }}
      style={
        background
          ? {
              backgroundImage: `linear-gradient(var(--background-overlay),var(--background-overlay)),url("${background}")`,
            }
          : undefined
      }
    >
      <aside className={`sidebar ${railCollapsed ? "rail-collapsed" : ""}`}>
        <div className="brand">
          <div className="brand-logo">
            <img
              className="brand-mark"
              src={appIcon}
              alt=""
              draggable={false}
            />
            <button
              className="sidebar-collapse"
              onClick={() => setCollapsed((current) => !current)}
              aria-label={railCollapsed ? "展开侧栏" : "收起侧栏"}
              aria-expanded={!railCollapsed}
              aria-controls="sidebar-navigation"
              disabled={narrow}
              data-tooltip={
                railCollapsed
                  ? narrow
                    ? "窗口较窄，侧栏自动收起"
                    : "展开侧栏"
                  : undefined
              }
              data-tooltip-placement="right"
            >
              <ChevronLeft className="collapse-chev" size={22} />
            </button>
          </div>
          <button
            className="brand-copy brand-home"
            onClick={() => app.setPage("home")}
            aria-label="SFMCL 首页"
            tabIndex={railCollapsed ? -1 : 0}
          >
            <BrandWordmark />
          </button>
        </div>
        <nav id="sidebar-navigation" aria-label="主导航">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={`has-surface ${app.page === n.id ? "active" : ""}`}
              aria-current={app.page === n.id ? "page" : undefined}
              aria-label={n.name}
              onClick={() => app.setPage(n.id)}
              data-tooltip={railCollapsed ? n.name : undefined}
              data-tooltip-placement="right"
            >
              <PixelFrame />
              <n.icon size={19} />
              <span className="nav-copy">{n.name}</span>
            </button>
          ))}
        </nav>
        <FavoriteVersions collapsed={railCollapsed} />
        <div className="sidebar-bottom">
          {showDownloadTasks && (
            <div
              className="sidebar-downloads"
              data-status={task?.status || "idle"}
            >
              <button
                className="sidebar-task has-surface"
                onClick={() => app.setPage("downloads")}
                aria-current={app.page === "downloads" ? "page" : undefined}
                aria-label={`下载中心：${downloadTitle}${task ? `，${statusLabel[task.status]}` : ""}`}
                data-tooltip={railCollapsed ? downloadTitle : undefined}
                data-tooltip-placement="right"
              >
                <PixelFrame />
                <ArrowDownToLine size={18} />
                <span className="task-copy">
                  <strong>{downloadTitle}</strong>
                  <small>
                    {task ? statusLabel[task.status] : "准备好下一次出发"}
                  </small>
                </span>
                {progress !== undefined && (
                  <b className="task-count has-surface">
                    <PixelFrame />
                    {progress}%
                  </b>
                )}
              </button>
              <SidebarProgress state={sidebarProgress} />
            </div>
          )}
          {!showDownloadTasks && (
            <div className="sidebar-tip has-surface">
              <PixelFrame />
              <Leaf size={19} />
              <p>
                每一个方块，
                <br />
                都是新的可能。
              </p>
            </div>
          )}
          <button
            className="profile-button has-surface"
            onClick={() => app.setPage("players")}
            aria-label={player ? `管理角色：${player.name}` : "添加你的角色"}
            data-tooltip={
              railCollapsed
                ? player
                  ? `管理角色：${player.name}`
                  : "添加你的角色"
                : undefined
            }
            data-tooltip-placement="right"
          >
            <PixelFrame />
            <span className="avatar has-surface" aria-hidden="true">
              <PixelFrame />
              <Skin player={player} face />
            </span>
            <span className="profile-copy">
              <strong>{player?.name || "添加你的角色"}</strong>
              <small>
                {player
                  ? player.online
                    ? "Microsoft 账号"
                    : "离线角色"
                  : "准备好开启冒险"}
              </small>
            </span>
            <ChevronRight className="profile-chev" size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace" ref={workspace}>
        <Titlebar />
        {Object.values(app.pageRoutes).flatMap((route) => {
          const owner = navigationPage(route);
          return pageViews(route).map((view) => {
            const Page = pages[view.page];
            return (
              <PageActivity
                key={`${owner}:${view.page}`}
                page={owner}
                view={view.page}
                active={app.page === owner && route.page === view.page}
              >
                <PageRouteProvider route={view}>
                  {!desktop && (
                    <div className="preview-banner has-surface">
                      <PixelFrame />
                      浏览器界面预览 · 文件、账号和游戏操作请在桌面应用运行
                    </div>
                  )}
                  <Page />
                </PageRouteProvider>
              </PageActivity>
            );
          });
        })}
        <WorkspaceFooter kind={app.page === "home" ? "launch" : "status"}>
          {app.page === "home" ? (
            <LaunchDock playerCaption={playerCaption} />
          ) : (
            <footer className="workspace-footer">
              <span className="workspace-footer-status">
                <FooterStatusIcon iconKey="dot">
                  <span className="status-dot" />
                </FooterStatusIcon>
                <FooterText
                  slot="message"
                  role="status"
                  text={active > 0 ? `${active} 个下载正在进行` : "准备就绪"}
                />
              </span>
              <FooterText
                slot="player"
                className="workspace-footer-player"
                data-tooltip={playerCaption || undefined}
                text={playerCaption}
              />
            </footer>
          )}
        </WorkspaceFooter>
      </div>
      <NotificationDeck
        notifications={app.notifications}
        onDismiss={app.dismissNotification}
      />
      <ModpackDropTarget />
    </div>
  );
}
function Home() {
  const app = useApp();
  const s = app.data.settings;
  const notices = useNotices(s.showNotices);
  const player = app.data.players.find((p) => p.uuid === s.activePlayer);
  return (
    <>
      <PageHeader
        icon={<Play />}
        eyebrow="LET'S PLAY"
        title={player ? `你好，${player.name}` : "准备好，开启新的冒险"}
        action={
          s.showNotices && (
            <NoticeRefreshButton
              loading={notices.loading}
              onRefresh={notices.refresh}
            />
          )
        }
      />
      {s.showNotices && <Notices {...notices} />}
    </>
  );
}
