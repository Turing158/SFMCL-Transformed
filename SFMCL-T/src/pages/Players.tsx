import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Pencil,
  RefreshCw,
  RotateCcw,
  Shirt,
  Flag,
  Trash2,
  Globe,
  ExternalLink,
  ChevronDown,
  KeyRound,
  LogIn,
  UserPlus,
} from "lucide-react";
import { useApp } from "../store";
import { usePageActive } from "../PageActivity";
import { usePlayerViewTransition } from "../usePlayerViewTransition";
import { usePointerReorder } from "../usePointerReorder";
import type { PointerReorderOptions } from "../usePointerReorder";
import { usePlayerAppearanceTransition } from "../usePlayerAppearanceTransition";
import { confirmAction, pick, external } from "../api";
import { Badge, Button, Skin, PixelFrame } from "../components";
import { PageTitle } from "../PageHeader";
import { usePlayerLogin } from "../usePlayerLogin";
import { useLittleSkinLogin } from "../useLittleSkinLogin";
import { usePlayerLoginTransition } from "../usePlayerLoginTransition";
import type { Player } from "../types";
import { playerAccountLabel } from "../playerAccountLabel";
import { PlayerSkinPreview } from "../PlayerSkinPreview";
import { useImageResource } from "../useImageResource";
import { nextPreviewMode, previewModeLabel } from "../playerPreview";
import type { PlayerPreviewMode } from "../playerPreview";
import { ContextMenu } from "../ContextMenu";
import type {
  ContextMenuAnchor,
  ContextMenuHandle,
  ContextMenuItem,
} from "../ContextMenu";
import type { PlayerLoginKind } from "../navigation";
import { PlayerProfileDialog } from "./PlayerProfileDialog";
import { PlayerYggdrasilLogin } from "./PlayerYggdrasilLogin";
import { isLittleSkinServer, yggdrasilServerLabel } from "../yggdrasilDrop";
import {
  littleSkinProviders,
  PlayerLittleSkinLogin,
} from "./PlayerLittleSkinLogin";
import {
  thirdPartyOAuthEnabled,
  thirdPartyOAuthMenuLabel,
} from "../playerLoginAvailability";
import type { PlayerProfileAction } from "./PlayerProfileDialog";
import {
  MicrosoftIcon,
  PlayerAuthIdentity,
  PlayerAuthStage,
  PlayerMicrosoftLogin,
  PlayerOfflineLogin,
} from "./PlayerLogin";
type PlayerView = "grove" | "gallery";
const viewKey = "sfmcl-t.players.view";
const reorderOptions: PointerReorderOptions = {
  rowSelector: ".players-card",
  keyAttribute: "data-player-key",
  allowedControl: ".players-select",
  overlayClass: "players-drag-overlay",
  draggingAttribute: "data-player-dragging",
  animationPrefix: "sfmcl-t-player",
  overlayParent: (list) =>
    list.closest<HTMLElement>(".players-page") ?? document.body,
};
const loginMethods = [
  { id: "offline", label: "离线登录", icon: <UserPlus size={16} /> },
  { id: "microsoft", label: "Microsoft 登录", icon: <MicrosoftIcon /> },
  {
    id: "yggdrasil-oauth",
    label: thirdPartyOAuthMenuLabel,
    icon: <KeyRound size={16} />,
    disabled: !thirdPartyOAuthEnabled,
  },
  { id: "yggdrasil", label: "第三方登录", icon: <Globe size={16} /> },
] satisfies (ContextMenuItem & { id: PlayerLoginKind })[];

// Pixel silhouettes from the approved preview.
function PlayerIcon({ kind = "user" }: { kind?: "user" | "users" | "grid" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path
        d={
          kind === "grid"
            ? "M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"
            : kind === "users"
              ? "M5 3h7v7H5ZM2 22v-7l4-2h5l4 2v7M16 3h4v7h-4m2 3 4 2v7"
              : "M8 3h8v8H8ZM4 22v-6l4-3h8l4 3v6"
        }
      />
    </svg>
  );
}

function RefreshLoginButton({ player }: { player: Player }) {
  const app = useApp();
  const pageActive = usePageActive();
  const visible = useRef(pageActive);
  visible.current = pageActive;
  const [refreshing, setRefreshing] = useState(false);
  const running = useRef(false);
  const settled = useRef(false);
  useEffect(() => {
    if (!pageActive && settled.current) {
      running.current = false;
      setRefreshing(false);
    }
  }, [pageActive]);

  return (
    <Button
      className="players-icon-button players-refresh"
      aria-label={`刷新 ${player.name} 登录`}
      aria-busy={refreshing}
      data-tooltip={refreshing ? "正在刷新登录…" : "刷新登录"}
      disabled={app.busy || refreshing}
      onClick={async () => {
        if (app.busy || running.current) return;
        running.current = true;
        settled.current = false;
        setRefreshing(true);
        try {
          await app.mutate(
            "players.refresh",
            { id: player.uuid },
            "登录已刷新",
          );
        } finally {
          settled.current = true;
          if (!visible.current) {
            running.current = false;
            setRefreshing(false);
          }
        }
      }}
    >
      <RefreshCw
        size={14}
        aria-hidden="true"
        className={refreshing ? "spin" : undefined}
        onAnimationIteration={() => {
          // Finish a full turn even for fast responses, then return to rest
          // without a partial-rotation jump or a timer surviving unmount.
          if (!settled.current) return;
          running.current = false;
          setRefreshing(false);
        }}
      />
    </Button>
  );
}

export function Players() {
  const app = useApp();
  const pageActive = usePageActive();
  const loginKind = app.route.page === "players" ? app.route.login : undefined;
  const loginMenuId = useId();
  const loginMenu = useRef<ContextMenuHandle>(null);
  const [loginMenuAnchor, setLoginMenuAnchor] =
    useState<ContextMenuAnchor | null>(null);
  const imported =
    app.route.page === "players" && app.route.login === "yggdrasil"
      ? app.route.yggdrasilImport
      : undefined;
  const thirdPartyLogin =
    loginKind === "yggdrasil" || loginKind === "yggdrasil-oauth";
  const yggdrasilTitle = imported
    ? "外置登录"
    : loginKind === "yggdrasil-oauth"
      ? "LittleSkin登录"
      : "第三方登录";
  const importedName = imported ? yggdrasilServerLabel(imported.server) : "";
  const auth = usePlayerLogin(loginKind === "microsoft");
  const littleSkinActive =
    thirdPartyOAuthEnabled &&
    (loginKind === "yggdrasil-oauth" ||
      !!(imported && isLittleSkinServer(imported.server)));
  const littleSkinAuth = useLittleSkinLogin(
    littleSkinActive,
    imported?.id ?? loginKind ?? "",
  );
  const browserAuth = littleSkinActive ? littleSkinAuth : auth;
  const { root, animateView } = usePlayerViewTransition();
  const loginState = usePlayerLoginTransition(
    root,
    loginKind === "microsoft" || littleSkinActive,
    browserAuth,
  );
  const [view, setView] = useState<PlayerView>(() => {
    try {
      return localStorage.getItem(viewKey) === "gallery" ? "gallery" : "grove";
    } catch {
      return "grove";
    }
  });
  const viewSwitchLabel = `切换为${view === "grove" ? "方块展台" : "林间营地"}`;
  const [modal, setModal] = useState<PlayerProfileAction | null>(null);
  const cardsRoot = useRef<HTMLDivElement>(null);
  const playerKeys = app.data.players.map((player) => player.uuid);
  const {
    order,
    draggingKey,
    cancel: cancelReorder,
  } = usePointerReorder(
    cardsRoot,
    playerKeys,
    view,
    reorderOptions,
    !app.busy && !loginKind && !modal ? app.reorderPlayers : undefined,
  );
  const playersById = new Map(
    app.data.players.map((player) => [player.uuid, player]),
  );
  const orderedPlayers = (order ?? playerKeys)
    .map((id) => playersById.get(id))
    .filter((player): player is Player => !!player);
  const defaultPreviewMode = app.data.settings.playerPreviewMode;
  const [previewMode, setPreviewMode] =
    useState<PlayerPreviewMode>(defaultPreviewMode);
  const [offlineName, setOfflineName] = useState("");
  const [loginPreviewMode, setLoginPreviewMode] =
    useState<PlayerPreviewMode>(defaultPreviewMode);
  const mode = loginKind ? loginPreviewMode : previewMode;
  // The authorization stage shows no scenery, so it must not resolve images.
  const backgroundType =
    mode === "3d" && (!loginKind || loginKind === "offline")
      ? app.data.settings.player3dBackgroundType
      : "current";
  const scene = `/assets/players/${view === "grove" ? "grass" : "gallery"}.svg`;
  const backgroundPath =
    backgroundType === "local" || backgroundType === "remote"
      ? app.data.settings.player3dBackground
      : "";
  // Remote URLs load directly in the WebView like the 2D background; local
  // files still need the image bridge. A failed image must not be retried for
  // every scene switch, so remember the path that could not be decoded.
  const { url: backgroundUrl } = useImageResource(backgroundPath, scene);
  const [brokenBackground, setBrokenBackground] = useState("");
  const customBackground =
    backgroundType !== "current" &&
    backgroundUrl !== scene &&
    brokenBackground !== backgroundPath;
  const scenerySource = customBackground ? backgroundUrl : scene;
  const lastLogin = useRef(loginKind);
  const focusAfterReturn = useRef(false);
  const selected = app.data.players.find(
    (p) => p.uuid === app.data.settings.activePlayer,
  );
  const previewPlayer: Player | undefined =
    loginKind === "offline"
      ? {
          uuid: "",
          name: offlineName || "Steve",
          online: false,
          skin: "",
          slim: false,
        }
      : selected;
  const { nameRef, displayedName, onSkinDraw } = usePlayerAppearanceTransition(
    previewPlayer,
    loginKind,
    mode,
    loginKind !== "offline",
  );
  useEffect(() => {
    setPreviewMode(defaultPreviewMode);
    setLoginPreviewMode(defaultPreviewMode);
  }, [defaultPreviewMode]);
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, view);
    } catch {
      /* View remains usable without storage. */
    }
  }, [view]);
  useEffect(() => {
    if (lastLogin.current !== loginKind) {
      if (!loginKind) focusAfterReturn.current = !!lastLogin.current;
      if (loginKind === "offline") {
        setOfflineName("");
        setLoginPreviewMode(defaultPreviewMode);
      }
      lastLogin.current = loginKind;
    }
    if (pageActive && !loginKind && !app.busy && focusAfterReturn.current) {
      root.current
        ?.querySelector<HTMLButtonElement>("[data-player-login-trigger]")
        ?.focus();
      focusAfterReturn.current = false;
    }
  }, [loginKind, app.busy, root, pageActive, defaultPreviewMode]);
  const close = () => setModal(null);
  useEffect(() => {
    if (!pageActive || loginKind) setModal(null);
  }, [pageActive, loginKind]);
  useEffect(() => {
    if (!pageActive || loginKind || app.busy) setLoginMenuAnchor(null);
  }, [pageActive, loginKind, app.busy]);
  const openLoginMenu = (element: HTMLButtonElement) => {
    const positionElement = element.parentElement ?? element;
    const rect = positionElement.getBoundingClientRect();
    setLoginMenuAnchor({
      element,
      positionElement,
      x: rect.right,
      y: rect.bottom,
      placement: "bottom-end",
    });
  };

  return (
    <div
      ref={root}
      className="players-page"
      data-view={view}
      data-login={loginKind}
      data-login-state={loginState || undefined}
      data-browser-auth={
        loginKind === "microsoft" || littleSkinActive || undefined
      }
    >
      <header className="players-heading">
        <PageTitle
          className="players-title"
          icon={<PlayerIcon />}
          title={
            loginKind === "offline"
              ? "离线登录"
              : loginKind === "microsoft"
                ? "Microsoft 登录"
                : thirdPartyLogin
                  ? yggdrasilTitle
                  : "角色管理"
          }
          eyebrow={
            loginKind === "offline"
              ? "OFFLINE LOGIN"
              : loginKind === "microsoft"
                ? "MICROSOFT LOGIN"
                : thirdPartyLogin
                  ? imported
                    ? "EXTERNAL LOGIN"
                    : loginKind === "yggdrasil-oauth"
                      ? "THIRD-PARTY AUTHORIZATION"
                      : "YGGDRASIL LOGIN"
                  : "PLAYER INVENTORY"
          }
        />
        {!loginKind && (
          <div className="players-login-actions">
            <Button
              primary
              disabled={app.busy}
              data-player-login-trigger
              aria-haspopup="menu"
              aria-expanded={!!loginMenuAnchor}
              aria-controls={loginMenuAnchor ? loginMenuId : undefined}
              onClick={(event) => {
                if (loginMenuAnchor) loginMenu.current?.close();
                else openLoginMenu(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  openLoginMenu(event.currentTarget);
                }
              }}
            >
              <LogIn size={15} aria-hidden="true" />
              登录
              <ChevronDown
                size={12}
                aria-hidden="true"
                className="players-login-chevron"
              />
            </Button>
          </div>
        )}
      </header>
      {loginMenuAnchor && pageActive && !loginKind && !app.busy && (
        <ContextMenu
          ref={loginMenu}
          anchor={loginMenuAnchor}
          title="登录方式"
          ariaLabel="登录方式"
          menuId={loginMenuId}
          showHeading={false}
          className="favorite-context-menu"
          items={loginMethods
            .filter(
              (method) =>
                method.id !== "yggdrasil-oauth" || thirdPartyOAuthEnabled,
            )
            .map((method) => ({
              ...method,
              onSelect: () => app.openPlayerLogin(method.id),
            }))}
          onClose={() => setLoginMenuAnchor(null)}
        />
      )}
      <div className="players-workspace">
        <section className="player-preview has-surface" aria-label="角色预览">
          <PixelFrame />
          <div className="players-stage">
            {littleSkinActive ? (
              <PlayerAuthStage
                auth={littleSkinAuth}
                stages={littleSkinProviders}
              />
            ) : loginKind === "microsoft" ? (
              <PlayerAuthStage auth={auth} />
            ) : thirdPartyLogin ? (
              <div className="players-yggdrasil-stage">
                <Globe size={80} strokeWidth={1} />
                <strong>
                  {imported
                    ? importedName
                    : loginKind === "yggdrasil-oauth"
                      ? thirdPartyOAuthEnabled
                        ? "LITTLESKIN"
                        : "第三方授权"
                      : "YGGDRASIL"}
                </strong>
                <span>
                  {imported
                    ? "连接你的皮肤站账号"
                    : loginKind === "yggdrasil-oauth"
                      ? thirdPartyOAuthEnabled
                        ? "通过浏览器授权连接你的角色"
                        : "授权登录暂未开放"
                      : "你的站点，你的角色"}
                </span>
              </div>
            ) : (
              <>
                <div
                  className="players-scenery"
                  data-background={backgroundType}
                  data-custom-background={customBackground || undefined}
                  aria-hidden="true"
                >
                  {backgroundType !== "none" && (
                    <img
                      key={scenerySource}
                      src={scenerySource}
                      alt=""
                      onError={() => {
                        if (customBackground && backgroundPath)
                          setBrokenBackground(backgroundPath);
                      }}
                    />
                  )}
                </div>
                <div className="players-stage-top">
                  <span className="players-stage-label" aria-hidden="true">
                    {loginKind === "offline" ? (
                      "NEW CHARACTER"
                    ) : (
                      <>
                        CHARACTER /{" "}
                        {String(
                          selected ? app.data.players.indexOf(selected) + 1 : 0,
                        ).padStart(2, "0")}
                      </>
                    )}
                  </span>
                  <Button
                    className="players-model"
                    disabled={
                      !!loginKind || !selected || selected.online || app.busy
                    }
                    data-tooltip={
                      loginKind
                        ? "创建角色后可切换模型"
                        : selected?.online
                          ? "更换皮肤时可选择正版角色模型"
                          : `切换为${selected?.slim ? "经典" : "纤细"}模型`
                    }
                    aria-label={`切换模型，当前${previewPlayer?.slim ? "纤细" : "经典"}模型`}
                    aria-pressed={!!previewPlayer?.slim}
                    onClick={() =>
                      selected &&
                      void app.mutate("players.skin", {
                        id: selected.uuid,
                        path: selected.skin || null,
                        slim: !selected.slim,
                      })
                    }
                  >
                    <RefreshCw size={12} />
                    {previewPlayer?.slim ? "纤细模型" : "经典模型"}
                  </Button>
                </div>
                <PlayerSkinPreview
                  player={previewPlayer}
                  mode={mode}
                  frameRate={app.data.settings.player3dFps}
                  defaultAction={app.data.settings.player3dAction}
                  onReady={onSkinDraw}
                />
                <span className="players-stage-corner" aria-hidden="true">
                  {view === "grove" ? "THE OVERWORLD" : "CREATIVE MODE"}
                </span>
                <Button
                  className="players-facing"
                  aria-label={`切换预览朝向，当前${previewModeLabel[mode]}`}
                  data-tooltip={`当前${previewModeLabel[mode]}，切换为${previewModeLabel[nextPreviewMode(mode)]}`}
                  onClick={() =>
                    loginKind
                      ? setLoginPreviewMode(nextPreviewMode(mode))
                      : setPreviewMode(nextPreviewMode(mode))
                  }
                >
                  <RefreshCw size={12} />
                  {previewModeLabel[mode]}
                </Button>
              </>
            )}
          </div>
          <div className="players-identity">
            {littleSkinActive ? (
              <PlayerAuthIdentity
                auth={littleSkinAuth}
                stages={littleSkinProviders}
              />
            ) : loginKind === "microsoft" ? (
              <PlayerAuthIdentity auth={auth} />
            ) : thirdPartyLogin ? (
              <div className="players-identity-top">
                <div className="players-identity-name">
                  <h2>{imported ? "站点登录" : "第三方验证"}</h2>
                  <span className="players-kind">
                    {imported
                      ? "验证服务器已从链接导入"
                      : "登录后可加入使用相同验证服务的服务器"}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="players-identity-top">
                  <div className="players-identity-name">
                    <div className="players-name-transition">
                      <h2 ref={nameRef} data-tooltip={displayedName}>
                        {displayedName}
                      </h2>
                    </div>
                    <span className="players-kind">
                      <PlayerIcon
                        kind={previewPlayer?.online ? "grid" : "user"}
                      />
                      {previewPlayer
                        ? playerAccountLabel(previewPlayer)
                        : "未选择角色"}
                    </span>
                  </div>
                  {previewPlayer && (
                    <span className="players-equipped">
                      <Check size={13} />
                      {loginKind ? "离线登录" : "当前角色"}
                    </span>
                  )}
                </div>
                {!loginKind && selected?.yggdrasil ? (
                  <div className="players-yggdrasil-manage">
                    <Button
                      disabled={app.busy}
                      onClick={() =>
                        void app.run(() =>
                          external(selected.yggdrasil!.homepage),
                        )
                      }
                    >
                      <ExternalLink size={15} />
                      打开验证站点
                    </Button>
                  </div>
                ) : (
                  !loginKind && (
                    <div
                      className={`players-actions${selected?.online ? " players-actions-online" : ""}`}
                    >
                      <div
                        className="players-skin-split players-split-button has-surface"
                        role="group"
                        aria-label="皮肤操作"
                      >
                        <PixelFrame />
                        <button
                          type="button"
                          className="players-skin-change players-action"
                          aria-label="更换皮肤"
                          disabled={!selected || app.busy}
                          onClick={() =>
                            void app.run(async () => {
                              if (!selected) return;
                              if (selected.online) {
                                app.clearError();
                                setModal({
                                  kind: "skin",
                                  player: selected,
                                  previewMode: mode,
                                });
                                return;
                              }
                              const path = await pick(false, ["png"]);
                              if (path)
                                await app.update(
                                  "players.skin",
                                  {
                                    id: selected.uuid,
                                    path,
                                    slim: selected.slim,
                                  },
                                  "皮肤已更新",
                                );
                            })
                          }
                        >
                          <Shirt size={15} aria-hidden="true" />
                          <span
                            className="players-action-label"
                            aria-hidden="true"
                          >
                            <span>更换皮肤</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="players-skin-reset players-split-secondary"
                          aria-label="重置皮肤"
                          data-tooltip={
                            selected?.online
                              ? "恢复正版账号默认皮肤"
                              : "重置皮肤"
                          }
                          disabled={!selected || app.busy}
                          onClick={async () => {
                            if (!selected) return;
                            if (
                              selected.online &&
                              !(await confirmAction(
                                `将 ${selected.name} 的正版皮肤恢复为默认皮肤？`,
                              ))
                            )
                              return;
                            await app.mutate(
                              "players.skin",
                              { id: selected.uuid, path: null, slim: false },
                              "已重置默认皮肤",
                            );
                          }}
                        >
                          <RotateCcw size={14} />
                        </button>
                      </div>
                      {selected?.online && (
                        <Button
                          className="players-action"
                          aria-label="更换披风"
                          disabled={app.busy}
                          onClick={() => {
                            app.clearError();
                            setModal({ kind: "cape", player: selected });
                          }}
                        >
                          <Flag size={14} aria-hidden="true" />
                          <span
                            className="players-action-label"
                            aria-hidden="true"
                          >
                            <span>更换披风</span>
                          </span>
                        </Button>
                      )}
                      <Button
                        className="players-action"
                        aria-label="更改名称"
                        disabled={!selected || app.busy}
                        onClick={() => {
                          if (!selected) return;
                          app.clearError();
                          setModal({ kind: "rename", player: selected });
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        <span
                          className="players-action-label"
                          aria-hidden="true"
                        >
                          <span>更改名称</span>
                        </span>
                      </Button>
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </section>
        <section
          className="players-collection"
          aria-labelledby="players-collection-title"
        >
          <header className="players-collection-heading">
            <h2 id="players-collection-title">
              {loginKind === "offline" ? (
                "离线登录"
              ) : loginKind === "microsoft" ? (
                "Microsoft 登录"
              ) : thirdPartyLogin ? (
                yggdrasilTitle
              ) : (
                <>
                  我的角色{" "}
                  <Badge>
                    {String(app.data.players.length).padStart(2, "0")}
                  </Badge>
                </>
              )}
            </h2>
            {!loginKind && (
              <button
                type="button"
                className="players-view-switch has-surface"
                aria-label={viewSwitchLabel}
                data-tooltip={viewSwitchLabel}
                onClick={() => {
                  cancelReorder();
                  animateView(() =>
                    setView((current) =>
                      current === "grove" ? "gallery" : "grove",
                    ),
                  );
                }}
              >
                <PixelFrame />
                <PlayerIcon kind={view === "grove" ? "grid" : "users"} />
              </button>
            )}
          </header>
          {loginKind === "offline" ? (
            <PlayerOfflineLogin
              name={offlineName}
              onNameChange={setOfflineName}
            />
          ) : loginKind === "microsoft" ? (
            <PlayerMicrosoftLogin auth={auth} />
          ) : littleSkinActive ? (
            <PlayerLittleSkinLogin
              auth={littleSkinAuth}
              importedServer={imported?.server}
            />
          ) : thirdPartyLogin ? (
            <PlayerYggdrasilLogin
              key={imported?.id ?? loginKind}
              method={loginKind === "yggdrasil-oauth" ? "browser" : "password"}
              importedServer={imported?.server}
            />
          ) : (
            <>
              {app.data.players.length === 0 ? (
                <div className="players-empty">
                  <img src="/assets/players/empty.svg" alt="" />
                  <h3>暂无角色</h3>
                </div>
              ) : (
                <div
                  ref={cardsRoot}
                  className="players-cards"
                  data-player-sortable={!app.busy}
                  role="region"
                  aria-label="角色列表"
                  tabIndex={0}
                >
                  {orderedPlayers.map((player) => (
                    <div
                      key={player.uuid}
                      data-player-key={player.uuid}
                      data-window-drag="false"
                      data-player-placeholder={
                        draggingKey === player.uuid ? "true" : undefined
                      }
                      className={`players-card has-surface ${selected?.uuid === player.uuid ? "selected" : ""}`}
                      style={{
                        viewTransitionName: `sfmcl-t-player-card-${CSS.escape(player.uuid)}`,
                      }}
                      onClick={(event) => {
                        if (
                          !app.busy &&
                          !(event.target as Element).closest("button")
                        )
                          void app.selectPlayer(player.uuid);
                      }}
                    >
                      <PixelFrame />
                      <button
                        type="button"
                        className="players-select"
                        aria-label={`选择角色 ${player.name}`}
                        aria-pressed={selected?.uuid === player.uuid}
                        aria-description="拖动调整顺序；也可按 Alt 加方向键移动角色"
                        disabled={app.busy}
                        onKeyDown={(event) => {
                          if (!event.altKey || app.busy) return;
                          const direction =
                            event.key === "ArrowUp" || event.key === "ArrowLeft"
                              ? -1
                              : event.key === "ArrowDown" ||
                                  event.key === "ArrowRight"
                                ? 1
                                : 0;
                          if (!direction) return;
                          event.preventDefault();
                          cancelReorder();
                          const next = [...playerKeys];
                          const from = next.indexOf(player.uuid);
                          const to = from + direction;
                          if (to < 0 || to >= next.length) return;
                          next.splice(from, 1);
                          next.splice(to, 0, player.uuid);
                          const control = event.currentTarget;
                          void app.reorderPlayers(next);
                          requestAnimationFrame(() => control.focus());
                        }}
                        onClick={() => void app.selectPlayer(player.uuid)}
                      >
                        <span className="players-avatar has-surface">
                          <PixelFrame />
                          <Skin player={player} face />
                        </span>
                        <span className="players-info">
                          <strong>{player.name}</strong>
                          <small>
                            <PlayerIcon
                              kind={player.online ? "grid" : "user"}
                            />
                            {playerAccountLabel(player)}
                          </small>
                        </span>
                      </button>
                      <div className="players-row-actions">
                        {player.online && (
                          <RefreshLoginButton player={player} />
                        )}
                        <Button
                          className="players-icon-button players-remove"
                          aria-label={`移除 ${player.name}`}
                          data-tooltip="移除角色"
                          disabled={app.busy}
                          onClick={async () => {
                            if (
                              await confirmAction(
                                `移除角色 ${player.name}？此操作不会删除游戏存档。`,
                              )
                            )
                              await app.run(() =>
                                app.update(
                                  "players.remove",
                                  { id: player.uuid },
                                  "角色已移除",
                                ),
                              );
                          }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="players-decoration" aria-hidden="true">
                <span />
                <i />
                <b />
              </div>
            </>
          )}
        </section>
      </div>
      {modal && (
        <PlayerProfileDialog
          key={`${modal.kind}:${modal.player.uuid}`}
          action={modal}
          onClose={close}
        />
      )}
    </div>
  );
}
