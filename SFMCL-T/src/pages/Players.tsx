import { Input } from "../controls";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Pencil,
  UserPlus,
  RefreshCw,
  RotateCcw,
  Shirt,
  Trash2,
} from "lucide-react";
import { useApp } from "../store";
import { usePageActive } from "../PageActivity";
import { usePlayerViewTransition } from "../usePlayerViewTransition";
import { usePlayerAppearanceTransition } from "../usePlayerAppearanceTransition";
import { api, confirmAction, external, pick } from "../api";
import { Badge, Button, Modal, Skin, PixelFrame } from "../components";
import { PageTitle } from "../PageHeader";
import { usePlayerLogin } from "../usePlayerLogin";
import { usePlayerLoginTransition } from "../usePlayerLoginTransition";
import type { Player } from "../types";
import { PlayerSkinPreview } from "../PlayerSkinPreview";
import { nextPreviewMode, previewModeLabel } from "../playerPreview";
import type { PlayerPreviewMode } from "../playerPreview";
import type { PlayerLoginKind } from "../navigation";
import {
  MicrosoftIcon,
  PlayerAuthIdentity,
  PlayerAuthStage,
  PlayerMicrosoftLogin,
  PlayerOfflineLogin,
} from "./PlayerLogin";
type PlayerView = "grove" | "gallery";
const viewKey = "sfmcl-t.players.view";

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
  const auth = usePlayerLogin(loginKind === "microsoft");
  const { root, animateView } = usePlayerViewTransition();
  const loginState = usePlayerLoginTransition(
    root,
    loginKind === "microsoft",
    auth,
  );
  const [view, setView] = useState<PlayerView>(() => {
    try {
      return localStorage.getItem(viewKey) === "gallery" ? "gallery" : "grove";
    } catch {
      return "grove";
    }
  });
  const viewSwitchLabel = `切换为${view === "grove" ? "方块展台" : "林间营地"}`;
  const [previewMode, setPreviewMode] = useState<PlayerPreviewMode>("front");
  const [modal, setModal] = useState<"rename" | null>(null);
  const [name, setName] = useState("");
  const [offlineName, setOfflineName] = useState("");
  const [loginPreviewMode, setLoginPreviewMode] =
    useState<PlayerPreviewMode>("front");
  const mode = loginKind ? loginPreviewMode : previewMode;
  const lastLogin = useRef(loginKind);
  const focusAfterReturn = useRef<PlayerLoginKind | null>(null);
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
    try {
      localStorage.setItem(viewKey, view);
    } catch {
      /* View remains usable without storage. */
    }
  }, [view]);
  useEffect(() => {
    if (lastLogin.current !== loginKind) {
      if (!loginKind) focusAfterReturn.current = lastLogin.current || null;
      if (loginKind === "offline") {
        setOfflineName("");
        setLoginPreviewMode("front");
      }
      lastLogin.current = loginKind;
    }
    if (pageActive && !loginKind && !app.busy && focusAfterReturn.current) {
      root.current
        ?.querySelector<HTMLButtonElement>(
          `[data-player-login="${focusAfterReturn.current}"]`,
        )
        ?.focus();
      focusAfterReturn.current = null;
    }
  }, [loginKind, app.busy, root, pageActive]);
  const close = () => setModal(null);

  return (
    <div
      ref={root}
      className="players-page"
      data-view={view}
      data-login={loginKind}
      data-login-state={loginState || undefined}
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
                : "角色管理"
          }
          eyebrow={
            loginKind === "offline"
              ? "OFFLINE LOGIN"
              : loginKind === "microsoft"
                ? "MICROSOFT LOGIN"
                : "PLAYER INVENTORY"
          }
        />
        <div className="players-login-actions">
          <Button
            primary={!loginKind}
            disabled={app.busy}
            data-player-login="offline"
            aria-pressed={loginKind === "offline"}
            onClick={() => app.openPlayerLogin("offline")}
          >
            <UserPlus size={15} />
            离线登录
          </Button>
          <Button
            disabled={app.busy}
            data-player-login="microsoft"
            aria-pressed={loginKind === "microsoft"}
            onClick={() => app.openPlayerLogin("microsoft")}
          >
            <MicrosoftIcon />
            Microsoft 登录
          </Button>
        </div>
      </header>
      <div className="players-workspace">
        <section className="player-preview has-surface" aria-label="角色预览">
          <PixelFrame />
          <div className="players-stage">
            {loginKind === "microsoft" ? (
              <PlayerAuthStage auth={auth} />
            ) : (
              <>
                <div className="players-scenery" aria-hidden="true">
                  <img
                    src={`/assets/players/${view === "grove" ? "grass" : "gallery"}.svg`}
                    alt=""
                  />
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
                          ? "正版角色模型由 Minecraft 账号管理"
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
            {loginKind === "microsoft" ? (
              <PlayerAuthIdentity auth={auth} />
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
                        ? previewPlayer.online
                          ? "Microsoft"
                          : "离线角色"
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
                {!loginKind && (
                  <div className="players-actions">
                    <div
                      className="players-skin-split players-split-button has-surface"
                      role="group"
                      aria-label="皮肤操作"
                    >
                      <PixelFrame />
                      <button
                        type="button"
                        className="players-skin-change"
                        disabled={!selected || app.busy}
                        onClick={() =>
                          void app.run(async () => {
                            if (!selected) return;
                            if (selected.online) {
                              await external(
                                "https://www.minecraft.net/zh-hans/msaprofile/mygames/editskin",
                              );
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
                        <Shirt size={15} />
                        更换皮肤
                      </button>
                      <button
                        type="button"
                        className="players-skin-reset players-split-secondary"
                        aria-label="重置皮肤"
                        data-tooltip={
                          selected?.online
                            ? "正版皮肤请在 Minecraft 官网管理"
                            : "重置皮肤"
                        }
                        disabled={!selected || selected.online || app.busy}
                        onClick={() =>
                          selected &&
                          void app.mutate(
                            "players.skin",
                            { id: selected.uuid, path: null, slim: false },
                            "已重置默认皮肤",
                          )
                        }
                      >
                        <RotateCcw size={14} />
                      </button>
                    </div>
                    <Button
                      disabled={!selected || app.busy}
                      onClick={() => {
                        if (selected?.online) {
                          void app.run(() =>
                            external(
                              "https://www.minecraft.net/zh-hans/msaprofile/mygames/editprofile",
                            ),
                          );
                          return;
                        }
                        setName(selected?.name || "");
                        setModal("rename");
                      }}
                    >
                      <Pencil size={14} />
                      更改名称
                    </Button>
                  </div>
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
                onClick={() =>
                  animateView(() =>
                    setView((current) =>
                      current === "grove" ? "gallery" : "grove",
                    ),
                  )
                }
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
          ) : (
            <>
              {app.data.players.length === 0 ? (
                <div className="players-empty">
                  <img src="/assets/players/empty.svg" alt="" />
                  <h3>暂无角色</h3>
                </div>
              ) : (
                <div
                  className="players-cards"
                  role="region"
                  aria-label="角色列表"
                  tabIndex={0}
                >
                  {app.data.players.map((player) => (
                    <div
                      key={player.uuid}
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
                        disabled={app.busy}
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
                            {player.online ? "Microsoft" : "离线角色"}
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
      {modal === "rename" && selected && (
        <Modal title="更改角色名称" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void app.run(async () => {
                await api("players.rename", { id: selected.uuid, name });
                await app.refresh();
                setModal(null);
              }, "角色名称已更新");
            }}
          >
            <label className="field">
              新的名称
              <Input
                autoFocus
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                required
                pattern="[A-Za-z0-9_]{1,16}"
              />
            </label>
            <p className="helper">
              离线 UUID 会随名称更新，已有世界中的玩家身份可能改变。
            </p>
            <div className="dialog-actions">
              <Button onClick={close}>取消</Button>
              <Button primary type="submit" disabled={app.busy}>
                保存名称
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
