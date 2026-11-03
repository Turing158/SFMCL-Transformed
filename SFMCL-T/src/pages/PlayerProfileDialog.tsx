import { useEffect, useRef, useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { api } from "../api";
import { Button, Modal, PixelFrame } from "../components";
import { Input, Select } from "../controls";
import { useApp } from "../store";
import type { Player, PlayerCape, PlayerNameChange } from "../types";
import type { PlayerPreviewMode } from "../playerPreview";
import { PlayerSkinDialog } from "./PlayerSkinDialog";
import { PlayerAppearancePreview } from "./PlayerAppearancePreview";

export interface PlayerProfileAction {
  kind: "skin" | "cape" | "rename";
  player: Player;
  previewMode?: PlayerPreviewMode;
}

export function PlayerProfileDialog({
  action,
  onClose,
}: {
  action: PlayerProfileAction;
  onClose: () => void;
}) {
  return action.kind === "skin" ? (
    <PlayerSkinDialog
      player={action.player}
      initialMode={action.previewMode}
      onClose={onClose}
    />
  ) : (
    <PlayerAccountDialog action={action} onClose={onClose} />
  );
}

function PlayerAccountDialog({
  action: { kind, player },
  onClose,
}: {
  action: PlayerProfileAction;
  onClose: () => void;
}) {
  const app = useApp();
  const { update } = app;
  const needsInfo =
    (kind === "cape" && player.capes == null) ||
    (kind === "rename" && player.online);
  const [loading, setLoading] = useState(needsInfo);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(player.name);
  const [capes, setCapes] = useState<PlayerCape[] | null>(player.capes ?? null);
  const [capeId, setCapeId] = useState(
    player.capes?.find((cape) => cape.active)?.id || "",
  );
  const capeChoice = useRef<string | null>(null);
  const [nameChange, setNameChange] = useState<PlayerNameChange | null>(null);
  const [previewMode, setPreviewMode] = useState<PlayerPreviewMode>("back");
  const previewPlayer: Player = {
    ...(app.data.players.find((value) => value.uuid === player.uuid) || player),
    cape:
      capes === null
        ? player.cape
        : capes.find((cape) => cape.id === capeId)?.url || "",
  };

  useEffect(() => {
    if (!needsInfo && !(kind === "cape" && revision > 0)) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    const load = async () => {
      try {
        if (kind === "cape") {
          const value = (await update("players.capes", {
            id: player.uuid,
            refresh: revision > 0,
          })) as PlayerCape[];
          if (!active) return;
          setCapes(value);
          const choice = capeChoice.current;
          if (
            choice !== null &&
            (choice === "" || value.some((cape) => cape.id === choice))
          ) {
            setCapeId(choice);
          } else {
            capeChoice.current = null;
            setCapeId(value.find((cape) => cape.active)?.id || "");
          }
        } else {
          const value = await api<PlayerNameChange>("players.namechange", {
            id: player.uuid,
          });
          if (active) setNameChange(value);
        }
      } catch (error) {
        if (active) setLoadError(String(error));
      } finally {
        if (active) setLoading(false);
      }
    };
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [kind, player.uuid, needsInfo, revision, update]);

  const disabled = saving || app.busy;
  const blocked =
    disabled ||
    loading ||
    (!!loadError && (kind === "rename" || capes === null));
  const validName = new RegExp(
    `^[A-Za-z0-9_]{${player.online ? 3 : 1},16}$`,
  ).test(name);
  const title = kind === "cape" ? "更换披风" : "更改角色名称";
  const changedAt = nameChange?.changedAt || nameChange?.createdAt;
  const nextChange = changedAt
    ? new Date(Date.parse(changedAt) + 30 * 24 * 60 * 60 * 1000)
    : null;

  return (
    <Modal
      title={title}
      onClose={onClose}
      closeDisabled={saving}
      className={`player-profile-dialog${kind === "cape" ? " player-cape-dialog" : ""}`}
    >
      {(requestClose) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (
              blocked ||
              (kind === "rename" &&
                (!validName ||
                  (player.online && !nameChange?.nameChangeAllowed)))
            )
              return;
            setSaving(true);
            void app
              .run(
                async () => {
                  if (kind === "cape") {
                    await app.update("players.cape", {
                      id: player.uuid,
                      capeId: capeId || null,
                    });
                  } else {
                    await app.update("players.rename", {
                      id: player.uuid,
                      name,
                    });
                  }
                  onClose();
                },
                kind === "cape" ? "披风已更新" : "角色名称已更新",
              )
              .finally(() => setSaving(false));
          }}
        >
          <div className={kind === "cape" ? "player-skin-layout" : undefined}>
            {kind === "cape" && (
              <PlayerAppearancePreview
                player={previewPlayer}
                mode={previewMode}
                onModeChange={setPreviewMode}
                disabled={saving}
                cape
              />
            )}
            <div
              className={kind === "cape" ? "player-skin-controls" : undefined}
            >
              {kind === "rename" && player.online && (
                <div className="player-name-notice has-surface" role="note">
                  <PixelFrame />
                  <Info size={16} aria-hidden="true" />
                  <span>更改名称后30天才能再次更改喔！</span>
                </div>
              )}
              {loading && (
                <p className="helper" role="status">
                  {kind === "cape"
                    ? "正在获取账号拥有的披风…"
                    : "正在查询改名资格…"}
                </p>
              )}
              {loadError && (
                <div className="inline-error" role="alert">
                  {loadError}
                </div>
              )}
              {loadError && kind === "rename" && (
                <Button
                  onClick={() => setRevision((value) => value + 1)}
                  disabled={disabled}
                >
                  重新获取
                </Button>
              )}

              {kind === "cape" && capes !== null && (
                <>
                  <label className="field">
                    账号披风
                    <Select
                      aria-label="账号披风"
                      value={capeId}
                      onValueChange={(value) => {
                        capeChoice.current = value;
                        setCapeId(value);
                      }}
                      disabled={disabled || loading}
                    >
                      <option value="">不佩戴披风</option>
                      {capes.map((cape) => (
                        <option key={cape.id} value={cape.id}>
                          {cape.name}
                          {cape.active ? "（当前佩戴）" : ""}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <p className="helper">
                    {capes.length
                      ? "只能使用此账号已获得的官方披风。"
                      : "此账号尚未获得官方披风。"}
                  </p>
                </>
              )}

              {kind === "rename" && (
                <>
                  <label className="field">
                    新的名称
                    <Input
                      autoFocus
                      value={name}
                      minLength={player.online ? 3 : 1}
                      maxLength={16}
                      onChange={(event) => setName(event.target.value)}
                      required
                      pattern={
                        player.online
                          ? "[A-Za-z0-9_]{3,16}"
                          : "[A-Za-z0-9_]{1,16}"
                      }
                      disabled={disabled}
                    />
                  </label>
                  <p className="helper">
                    {player.online
                      ? "需要 3–16 个英文字母、数字或下划线。"
                      : "离线 UUID 会随名称更新，已有世界中的玩家身份可能改变。"}
                  </p>
                  {nameChange && !nameChange.nameChangeAllowed && (
                    <p className="inline-error" role="status">
                      此账号暂时不能改名。
                      {nextChange &&
                      Number.isFinite(nextChange.getTime()) &&
                      nextChange.getTime() > Date.now()
                        ? `预计 ${nextChange.toLocaleString()} 后可再次修改，以 Minecraft 返回的资格为准。`
                        : "通常需距上次改名或创建角色满 30 天。"}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="dialog-actions">
            {kind === "cape" && (
              <Button
                aria-label="刷新披风"
                onClick={() => setRevision((value) => value + 1)}
                disabled={disabled || loading}
              >
                <RefreshCw size={14} className={loading ? "spin" : undefined} />
                {loading ? "刷新中…" : "刷新"}
              </Button>
            )}
            <Button onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button
              primary
              type="submit"
              disabled={
                blocked ||
                (kind === "rename" &&
                  (!validName ||
                    name === player.name ||
                    (player.online && !nameChange?.nameChangeAllowed)))
              }
            >
              {saving ? "正在保存…" : kind === "cape" ? "保存披风" : "保存名称"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
