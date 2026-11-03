import { RefreshCw } from "lucide-react";
import { Button, PixelFrame } from "../components";
import { PlayerSkinPreview } from "../PlayerSkinPreview";
import { nextPreviewMode, previewModeLabel } from "../playerPreview";
import type { PlayerPreviewMode, PreviewReady } from "../playerPreview";
import { useApp } from "../store";
import type { Player } from "../types";

const previewReady: PreviewReady = (_canvas, draw) => draw();

export function PlayerAppearancePreview({
  player,
  mode,
  onModeChange,
  disabled = false,
  cape = false,
}: {
  player: Player;
  mode: PlayerPreviewMode;
  onModeChange: (mode: PlayerPreviewMode) => void;
  disabled?: boolean;
  cape?: boolean;
}) {
  const { data } = useApp();
  const label = cape ? "披风" : "皮肤";
  return (
    <div
      className={`players-stage player-skin-preview has-surface${cape ? " player-cape-preview" : ""}`}
      aria-label={`${label}效果预览`}
      data-model={player.slim ? "slim" : "classic"}
      data-cape={player.cape || ""}
    >
      <PixelFrame />
      <PlayerSkinPreview
        player={player}
        mode={mode}
        frameRate={data.settings.player3dFps}
        defaultAction={data.settings.player3dAction}
        showCape={cape}
        backFacing={cape}
        onReady={previewReady}
      />
      <div className="player-skin-preview-tools">
        <span>{player.name}</span>
        <Button
          className="players-facing"
          aria-label={`切换${label}预览，当前${previewModeLabel[mode]}`}
          data-tooltip={`切换为${previewModeLabel[nextPreviewMode(mode)]}`}
          onClick={() => onModeChange(nextPreviewMode(mode))}
          disabled={disabled}
        >
          <RefreshCw size={12} aria-hidden="true" />
          {previewModeLabel[mode]}
        </Button>
      </div>
    </div>
  );
}
