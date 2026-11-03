import { useEffect, useRef, useState } from "react";
import { api, pick } from "../api";
import { Button, Modal } from "../components";
import { Switch } from "../controls";
import { PlayerAppearancePreview } from "./PlayerAppearancePreview";
import type { PlayerPreviewMode } from "../playerPreview";
import { useApp } from "../store";
import type { Player } from "../types";

export function PlayerSkinDialog({
  player,
  initialMode,
  onClose,
}: {
  player: Player;
  initialMode?: PlayerPreviewMode;
  onClose: () => void;
}) {
  const app = useApp();
  const [draft, setDraft] = useState<{ path: string; url: string } | null>(
    null,
  );
  const [slim, setSlim] = useState(player.slim);
  const [mode, setMode] = useState(
    initialMode || app.data.settings.playerPreviewMode,
  );
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = saving || app.busy;
  const previewPlayer: Player = {
    ...player,
    skin: draft?.url || player.skin,
    slim,
  };
  const filename = draft?.path.split(/[\\/]/).at(-1);

  const chooseFile = () =>
    void app.run(async () => {
      const path = await pick(false, ["png"], {
        title: "选择 Minecraft 皮肤",
        filterName: "PNG 皮肤",
      });
      if (!path || !mounted.current) return;
      try {
        const url = await api<string>("players.skin.preview", { path });
        const image = new Image();
        image.src = url;
        await image.decode().catch(() => {
          throw new Error("皮肤图片无法读取，请选择有效的 PNG 文件");
        });
        if (
          image.naturalWidth !== 64 ||
          ![32, 64].includes(image.naturalHeight)
        ) {
          throw new Error("皮肤需要为 64×64 或 64×32 像素");
        }
        if (mounted.current) setDraft({ path, url });
      } catch (error) {
        if (mounted.current) throw error;
      }
    });

  return (
    <Modal
      title="更换正版皮肤"
      onClose={onClose}
      closeDisabled={saving}
      className="player-profile-dialog player-skin-dialog"
    >
      {(requestClose) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !draft || submitting.current) return;
            submitting.current = true;
            setSaving(true);
            void app
              .run(async () => {
                await app.update("players.skin", {
                  id: player.uuid,
                  path: draft.path,
                  slim,
                });
                onClose();
              }, "皮肤已更新")
              .finally(() => {
                submitting.current = false;
                if (mounted.current) setSaving(false);
              });
          }}
        >
          <div className="player-skin-layout">
            <PlayerAppearancePreview
              player={previewPlayer}
              mode={mode}
              onModeChange={setMode}
              disabled={saving}
            />
            <div className="player-skin-controls">
              <div className="player-skin-file">
                <Button disabled={disabled} onClick={chooseFile}>
                  选择皮肤文件
                </Button>
                <span className="helper" title={filename}>
                  {filename || "尚未选择文件"}
                </span>
              </div>
              <div className="player-skin-model">
                <span>纤细模型</span>
                <Switch
                  aria-label="纤细模型"
                  checked={slim}
                  onCheckedChange={setSlim}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
          <div className="dialog-actions">
            <Button onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button primary type="submit" disabled={disabled || !draft}>
              {saving ? "正在保存…" : "上传皮肤"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
