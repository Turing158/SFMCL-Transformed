import { FolderOpen, RefreshCw, RotateCcw } from "lucide-react";
import { Input, Select, Slider } from "./controls";
import { Button, PixelFrame } from "./components";
import { useApp } from "./store";
import { pick } from "./api";
import { invalidateImages } from "./images";
import { backgroundDefaults } from "./background";
import type { Settings } from "./types";

export function BackgroundSettings({
  draft,
  onChange,
}: {
  draft: Settings;
  onChange: (changes: Partial<Settings>) => void;
}) {
  const app = useApp();
  const opacity =
    draft.backgroundOverlayOpacity ??
    backgroundDefaults.backgroundOverlayOpacity;
  const blur = draft.backgroundBlur ?? backgroundDefaults.backgroundBlur;
  const disabled = draft.backgroundType === "none";
  return (
    <section
      className="panel settings-section background-settings has-surface"
      aria-labelledby="background-settings-title"
    >
      <PixelFrame />
      <h2 id="background-settings-title">背景</h2>
      <p>只显示在内容区域，调整后自动保存。</p>
      <div className="background-settings-controls">
        <label className="field">
          背景来源
          <Select
            value={draft.backgroundType}
            onValueChange={(value) => onChange({ backgroundType: value })}
          >
            <option value="none">纯色背景</option>
            <option value="default">配置目录中的 bg.png / bg.jpg</option>
            <option value="local">本地图片</option>
            <option value="remote">网络图片</option>
          </Select>
        </label>
        {["local", "remote"].includes(draft.backgroundType) && (
          <label className="field">
            图片路径或 URL
            <div className="input-action">
              <Input
                aria-label="图片路径或 URL"
                value={draft.background}
                onChange={(event) =>
                  onChange({ background: event.target.value })
                }
                placeholder={
                  draft.backgroundType === "local"
                    ? "选择 JPG / PNG 图片"
                    : "https://…"
                }
              />
              {draft.backgroundType === "local" && (
                <Button
                  aria-label="选择背景图片"
                  onClick={() =>
                    void app.run(async () => {
                      const path = await pick(false, ["png", "jpg", "jpeg"]);
                      if (path) {
                        invalidateImages([path]);
                        onChange({ background: path });
                      }
                    })
                  }
                >
                  <FolderOpen size={16} />
                  选择
                </Button>
              )}
            </div>
          </label>
        )}
        <label className="field background-effect-field">
          <span className="background-effect-label">
            <span>遮罩透明度</span>
            <output>{100 - opacity}%</output>
          </span>
          <Slider
            aria-label="遮罩透明度"
            aria-valuetext={`${100 - opacity}%`}
            min={0}
            max={100}
            step={1}
            value={100 - opacity}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                backgroundOverlayOpacity: 100 - Number(event.target.value),
              })
            }
          />
          <span className="background-effect-hint">
            越透明，背景图片越清晰。
          </span>
        </label>
        <label className="field background-effect-field">
          <span className="background-effect-label">
            <span>背景虚化程度</span>
            <output>{blur} px</output>
          </span>
          <Slider
            aria-label="背景虚化程度"
            aria-valuetext={`${blur} 像素`}
            min={0}
            max={30}
            step={1}
            value={blur}
            disabled={disabled}
            onChange={(event) =>
              onChange({ backgroundBlur: Number(event.target.value) })
            }
          />
          <span className="background-effect-hint">
            只虚化图片，保持内容清晰。
          </span>
        </label>
        <div className="row-actions background-settings-actions">
          <Button
            onClick={() =>
              void app.run(() => app.refresh("backgrounds"), "背景图片已刷新")
            }
          >
            <RefreshCw size={16} />
            刷新背景图片
          </Button>
          <Button
            disabled={
              disabled ||
              (opacity === backgroundDefaults.backgroundOverlayOpacity &&
                blur === backgroundDefaults.backgroundBlur)
            }
            onClick={() => onChange(backgroundDefaults)}
          >
            <RotateCcw size={16} />
            重置效果
          </Button>
        </div>
      </div>
    </section>
  );
}
