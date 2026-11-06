import { Input, Select, Switch } from "../controls";
import { useState } from "react";
import { Check, FolderOpen, RefreshCw, Settings2 } from "lucide-react";
import { PageHeader } from "../PageHeader";
import { useApp } from "../store";
import { api, pick } from "../api";
import { Button, TabList, TabPanel, PixelFrame } from "../components";
import { GameSettingsFields } from "./GameSettingsFields";
import type { HomeNoticeLayout, Settings } from "../types";
import {
  appIcon,
  BRAND_WORDMARK,
  BRAND_FULL_NAME,
  BRAND_EDITION,
  BRAND_TAGLINE,
} from "../branding";
import { useTabContentTransition } from "../useTabContentTransition";
import { useButtonPressFeedback } from "../useButtonPressFeedback";
import {
  absoluteSettingsPath,
  prepareSettings,
  withJavaPaths,
} from "../gameSettings";
import { useAutoSavedSettings } from "../useAutoSavedSettings";
import { UpdateCheckButton, useUpdateCheck } from "../UpdateCheckButton";
import { LocalDataSettings } from "../LocalDataSettings";
import { previewModeLabel } from "../playerPreview";
import type {
  Player3DBackgroundType,
  PlayerPreviewMode,
} from "../playerPreview";
import { player3dActions, player3dActionLabel } from "../player3dActions";
import type { Player3DAction } from "../player3dActions";
import "../settings.css";

export function SettingsPage() {
  const app = useApp();
  const pressFeedback = useButtonPressFeedback("sfmcl-t-settings-press");
  const [tab, setTab] = useState("launcher");
  const updateCheck = useUpdateCheck();
  const tabContent = useTabContentTransition(
    ["launcher", "game", "about"].indexOf(tab),
  );
  const autoSave = useAutoSavedSettings(
    app.data.settings,
    app.autoSaveSettings,
    prepareSettings,
    (error) => app.reportError(`设置自动保存失败：${String(error)}`),
  );
  const draft = autoSave.draft ?? app.data.settings;
  const downloadSource = draft.minecraftDownloadSource || "auto";
  const { setDraft } = autoSave;
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((s) => ({ ...s, [key]: value }));
  const toggle = (
    key: "hardwareAcceleration" | "homeCleanMode",
    title: string,
    description?: string,
  ) => (
    <div
      className={
        description ? "setting-row" : "setting-row setting-row-compact"
      }
    >
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <Switch
        checked={draft[key]}
        aria-label={title}
        onCheckedChange={(checked) => change(key, checked)}
      />
    </div>
  );
  return (
    <div
      className="settings-page"
      onClickCapture={pressFeedback}
      data-saving={autoSave.saving}
    >
      <PageHeader icon={<Settings2 />} eyebrow="MAKE IT YOURS" title="设置" />
      <TabList
        id="settings"
        className="settings-tabs"
        label="设置分类"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "launcher", label: "启动器设置" },
          { value: "game", label: "全局设置" },
          { value: "about", label: "关于" },
        ]}
      />
      <TabPanel ref={tabContent} id="settings" value={tab}>
        {tab === "game" && (
          <div className="settings-stack">
            <GameSettingsFields
              draft={draft}
              onJavaPathsSave={async (paths, removedPath) => {
                const saved = await app.saveJavaPaths(paths, removedPath);
                autoSave.sync((current) =>
                  withJavaPaths(current, saved, removedPath),
                );
                return saved;
              }}
              setDraft={(update) =>
                setDraft((current) => ({ ...current, ...update(current) }))
              }
            />
          </div>
        )}
        {tab === "launcher" && (
          <div className="settings-stack">
            <section className="panel settings-section has-surface">
              <PixelFrame />
              <h2>外观</h2>
              <div className="theme-options">
                {[
                  ["light", "明亮"],
                  ["dark", "深色"],
                  ["system", "跟随系统"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`has-surface theme-option ${value} ${draft.theme === value ? "selected" : ""}`}
                    aria-pressed={draft.theme === value}
                    onClick={() => change("theme", value)}
                  >
                    <PixelFrame />
                    <div className="theme-preview">
                      <i />
                      <span />
                    </div>
                    <span>
                      {label}
                      {draft.theme === value && <Check size={15} />}
                    </span>
                  </button>
                ))}
              </div>
              <label className="field">
                主题配色
                <Select
                  value={draft.accent}
                  onValueChange={(value) => change("accent", value)}
                >
                  <option value="forest">主世界配色</option>
                  <option value="nether">地狱配色</option>
                  <option value="end">末地配色</option>
                  <option value="sift">筛界配色</option>
                </Select>
              </label>
              <label className="field">
                背景来源
                <Select
                  value={draft.backgroundType}
                  onValueChange={(value) => change("backgroundType", value)}
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
                      value={draft.background}
                      onChange={(e) => change("background", e.target.value)}
                      placeholder={
                        draft.backgroundType === "local"
                          ? "选择 JPG / PNG 图片"
                          : "https://…"
                      }
                    />
                    {draft.backgroundType === "local" && (
                      <Button
                        onClick={() =>
                          void app.run(async () => {
                            const path = await pick(false, [
                              "png",
                              "jpg",
                              "jpeg",
                            ]);
                            if (path) change("background", path);
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
              {toggle(
                "hardwareAcceleration",
                "硬件加速",
                "使用 GPU 渲染界面，修改后重新启动应用生效。",
              )}
              <div className="row-actions">
                <Button
                  onClick={() => void app.run(app.refresh, "背景与图片已刷新")}
                >
                  <RefreshCw size={16} />
                  刷新背景图片
                </Button>
              </div>
            </section>
            <section className="panel settings-section has-surface">
              <PixelFrame />
              <h2>开始游戏界面</h2>
              {toggle("homeCleanMode", "干净模式")}
              <label className="field">
                公告布局
                <Select
                  value={draft.homeNoticeLayout || "masonry"}
                  aria-label="公告布局"
                  disabled={draft.homeCleanMode}
                  onValueChange={(value) =>
                    change("homeNoticeLayout", value as HomeNoticeLayout)
                  }
                >
                  <option value="single">一行一个折叠面板</option>
                  <option value="parallel">双列平行布局</option>
                  <option value="masonry">双列瀑布布局（默认）</option>
                </Select>
              </label>
            </section>
            <section className="panel settings-section has-surface">
              <PixelFrame />
              <h2>角色管理 · 皮肤预览</h2>
              <div className="form-grid">
                <label className="field">
                  默认预览方式
                  <Select
                    value={draft.playerPreviewMode}
                    aria-label="默认预览方式"
                    onValueChange={(value) =>
                      change("playerPreviewMode", value as PlayerPreviewMode)
                    }
                  >
                    {(["front", "back", "3d"] as const).map((mode) => (
                      <option key={mode} value={mode}>
                        {previewModeLabel[mode]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  3D 预览帧数
                  <Select
                    aria-label="3D 预览帧数"
                    value={String(draft.player3dFps)}
                    displayValue={draft.player3dFps}
                    onValueChange={(value) =>
                      change("player3dFps", Number(value))
                    }
                  >
                    {[10, 24, 30, 45, 60].map((fps) => (
                      <option key={fps} value={fps}>
                        {fps}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  3D 预览背景
                  <Select
                    value={draft.player3dBackgroundType}
                    aria-label="3D 预览背景"
                    onValueChange={(value) =>
                      change(
                        "player3dBackgroundType",
                        value as Player3DBackgroundType,
                      )
                    }
                  >
                    <option value="current">当前场景（默认）</option>
                    <option value="none">纯色背景</option>
                    <option value="local">本地图片</option>
                    <option value="remote">网络图片</option>
                  </Select>
                </label>
                <label className="field">
                  3D 默认动作
                  <Select
                    value={draft.player3dAction}
                    aria-label="3D 默认动作"
                    onValueChange={(value) =>
                      change("player3dAction", value as Player3DAction)
                    }
                  >
                    {player3dActions.map((action) => (
                      <option key={action} value={action}>
                        {player3dActionLabel[action]}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {["local", "remote"].includes(draft.player3dBackgroundType) && (
                <label className="field">
                  3D 背景图片路径或 URL
                  <div className="input-action">
                    <Input
                      value={draft.player3dBackground}
                      aria-label="3D 背景图片路径或 URL"
                      onChange={(event) =>
                        change("player3dBackground", event.target.value)
                      }
                      placeholder={
                        draft.player3dBackgroundType === "local"
                          ? "选择 JPG / PNG 图片"
                          : "https://…"
                      }
                    />
                    {draft.player3dBackgroundType === "local" && (
                      <Button
                        onClick={() =>
                          void app.run(async () => {
                            const path = await pick(false, [
                              "png",
                              "jpg",
                              "jpeg",
                            ]);
                            if (path) change("player3dBackground", path);
                          })
                        }
                      >
                        <FolderOpen size={16} />
                        选择 3D 背景图片
                      </Button>
                    )}
                  </div>
                </label>
              )}
            </section>
            <section className="panel settings-section has-surface">
              <PixelFrame />
              <h2>下载</h2>
              <div className="field">
                <label htmlFor="download-cache-dir">下载缓存文件夹</label>
                <div className="input-action cache-directory-actions">
                  <Input
                    id="download-cache-dir"
                    value={draft.downloadCacheDir || ""}
                    onChange={(e) => change("downloadCacheDir", e.target.value)}
                    onBlur={() => {
                      if (!absoluteSettingsPath(draft.downloadCacheDir))
                        app.reportError("下载缓存文件夹必须是绝对路径");
                    }}
                    placeholder={
                      app.data.defaultDownloadCacheDir ||
                      "默认：配置目录 / downloads / cache"
                    }
                  />
                  <Button
                    onClick={() =>
                      void app.run(async () => {
                        const path = await pick(true);
                        if (path) change("downloadCacheDir", path);
                      })
                    }
                  >
                    <FolderOpen size={16} />
                    选择文件夹
                  </Button>
                  <button
                    type="button"
                    className="icon-button has-surface"
                    aria-label="打开下载缓存文件夹"
                    data-tooltip="打开下载缓存文件夹"
                    disabled={app.busy}
                    onClick={() =>
                      void app.run(() =>
                        api("downloads.cache.open", {
                          path: draft.downloadCacheDir,
                        }),
                      )
                    }
                  >
                    <PixelFrame />
                    <FolderOpen size={17} />
                  </button>
                </div>
              </div>
              <div className="form-grid download-options-grid">
                <div className="field">
                  <label htmlFor="download-source-strategy">下载源策略</label>
                  <Select
                    id="download-source-strategy"
                    aria-label="下载源策略"
                    value={downloadSource}
                    onValueChange={(value) =>
                      change(
                        "minecraftDownloadSource",
                        value as Settings["minecraftDownloadSource"],
                      )
                    }
                  >
                    <option value="auto">速度优先（推荐）</option>
                    <option value="official">官网优先</option>
                    <option value="bmclapi">镜像优先</option>
                  </Select>
                </div>
                <label className="field">
                  同时下载数
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={draft.downloadConcurrency}
                    onChange={(e) =>
                      change("downloadConcurrency", Number(e.target.value))
                    }
                    onBlur={() =>
                      change(
                        "downloadConcurrency",
                        Math.min(
                          32,
                          Math.max(
                            1,
                            Math.round(draft.downloadConcurrency) || 1,
                          ),
                        ),
                      )
                    }
                  />
                </label>
                <label className="field download-task-display">
                  侧栏下载任务
                  <Select
                    aria-label="侧栏下载任务"
                    value={draft.downloadTaskDisplay || "off"}
                    onValueChange={(value) =>
                      change("downloadTaskDisplay", value)
                    }
                  >
                    <option value="active">下载时</option>
                    <option value="always">始终</option>
                    <option value="off">关闭</option>
                  </Select>
                </label>
              </div>
            </section>
            <LocalDataSettings />
          </div>
        )}
        {tab === "about" && (
          <div className="settings-stack">
            <section className="panel about-card has-surface">
              <PixelFrame />
              <img
                className="about-mark"
                src={appIcon}
                alt={`${BRAND_WORDMARK} 软件图标`}
                draggable={false}
              />
              <div className="about-remade-kicker">
                <span className="about-remade-mark" aria-label="T 重制标记">
                  T
                </span>
                <span className="about-remade-edition">{BRAND_EDITION}</span>
                <span className="about-remade-tagline">{BRAND_TAGLINE}</span>
              </div>
              <h2>{BRAND_WORDMARK}</h2>
              <p className="about-full-name">{BRAND_FULL_NAME}</p>
              <span className="badge has-surface">
                <PixelFrame />v{app.data.version} · Rust + Tauri
              </span>
              <UpdateCheckButton {...updateCheck} />
            </section>
          </div>
        )}
      </TabPanel>
    </div>
  );
}
