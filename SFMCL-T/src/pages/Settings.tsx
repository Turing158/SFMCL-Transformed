import { Input, Select, Switch } from "../controls";
import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, RefreshCw, Settings2 } from "lucide-react";
import { PageHeader } from "../PageHeader";
import { useApp } from "../store";
import { api, pick } from "../api";
import { Button, TabList, TabPanel, PixelFrame } from "../components";
import { GameSettingsFields } from "./GameSettingsFields";
import type { Settings } from "../types";
import {
  appIcon,
  BRAND_WORDMARK,
  BRAND_FULL_NAME,
  BRAND_EDITION,
  BRAND_TAGLINE,
} from "../branding";
import { useTabContentTransition } from "../useTabContentTransition";
import { useButtonPressFeedback } from "../useButtonPressFeedback";
import { SaveBar, SaveButton } from "../SaveBar";
import { mergeSavedSettings, withJavaPaths } from "../gameSettings";
import "../settings.css";
export function SettingsPage() {
  const app = useApp();
  const pressFeedback = useButtonPressFeedback("sfmcl-t-settings-press");
  const [tab, setTab] = useState("launcher");
  const tabContent = useTabContentTransition(
    ["launcher", "game", "about"].indexOf(tab),
  );
  const [draft, setDraft] = useState<Settings>(app.data.settings);
  const [update, setUpdate] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(app.data.settings);
  const savedSettings = JSON.stringify(app.data.settings);
  const previousSettings = useRef(app.data.settings);
  useEffect(() => {
    const next = JSON.parse(savedSettings) as Settings;
    const previous = previousSettings.current;
    setDraft((current) => mergeSavedSettings(current, previous, next));
    previousSettings.current = next;
  }, [savedSettings]);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((s) => ({ ...s, [key]: value }));
  const toggle = (
    key: "hardwareAcceleration" | "showNotices",
    title: string,
    description: string,
  ) => (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <Switch
        checked={draft[key]}
        aria-label={title}
        onCheckedChange={(checked) => change(key, checked)}
      />
    </div>
  );
  return (
    <div className="settings-page" onClickCapture={pressFeedback}>
      <PageHeader
        icon={<Settings2 />}
        eyebrow="MAKE IT YOURS"
        title="设置"
        action={
          <SaveButton
            showIndicator
            disabled={!dirty || app.busy}
            onSave={() => void app.run(() => app.save(draft), "设置已保存")}
          />
        }
      />
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
            <p className="helper">
              未启用独立设置的版本使用以下配置。可在版本管理中为每个版本单独设置。
            </p>
            <GameSettingsFields
              draft={draft}
              onJavaPathsSave={async (paths, removedPath) => {
                const saved = await app.saveJavaPaths(paths, removedPath);
                setDraft((current) =>
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
                  <option value="forest">森林绿</option>
                  <option value="puce">原版 · Puce</option>
                  <option value="ebony">原版 · Ebony</option>
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
              {toggle(
                "showNotices",
                "显示公告",
                "读取配置目录中的 Notices.json，支持 Markdown 文档和图片。",
              )}
              <div className="row-actions">
                <Button
                  onClick={() => {
                    app.setPage("home");
                  }}
                >
                  <RefreshCw size={16} />
                  查看与刷新公告
                </Button>
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
              <h2>下载</h2>
              <div className="field">
                <label htmlFor="download-cache-dir">下载缓存文件夹</label>
                <div className="input-action cache-directory-actions">
                  <Input
                    id="download-cache-dir"
                    value={draft.downloadCacheDir || ""}
                    onChange={(e) => change("downloadCacheDir", e.target.value)}
                    placeholder={
                      app.data.defaultDownloadCacheDir ||
                      "默认：配置目录 / downloads / cache"
                    }
                    aria-describedby="download-cache-help"
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
                <small id="download-cache-help">
                  留空使用默认目录。保存后用于新下载，已有任务继续使用原缓存目录；文件完成后自动清理缓存。
                </small>
              </div>
              <div className="form-grid">
                <label className="field">
                  同时下载文件数
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={draft.downloadConcurrency}
                    onChange={(e) =>
                      change("downloadConcurrency", Number(e.target.value))
                    }
                  />
                  <small>1–32，重新启动后使用新的并发上限。</small>
                </label>
                <label className="field">
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
                  <small>
                    默认关闭。“下载时”在有未结束的下载或步骤任务时显示。
                  </small>
                </label>
              </div>
            </section>
            <section className="panel settings-section has-surface">
              <PixelFrame />
              <h2>本地数据</h2>
              <p className="path-text">
                {app.data.dataDir || "在桌面应用中查看配置目录"}
              </p>
              <Button
                onClick={() =>
                  void app.run(() =>
                    api("path.open", { path: app.data.dataDir }),
                  )
                }
              >
                <FolderOpen size={16} />
                打开配置目录
              </Button>
            </section>
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
              <div className="row-actions">
                <Button
                  onClick={() =>
                    void app.run(async () => {
                      const release = await api<{
                        tag_name: string;
                        html_url: string;
                      }>("updates");
                      setUpdate(`原项目最新发布：${release.tag_name}`);
                    })
                  }
                >
                  <RefreshCw size={16} />
                  检查原项目更新
                </Button>
              </div>
              {update && <p>{update}</p>}
            </section>
          </div>
        )}
      </TabPanel>
      <SaveBar
        visible={dirty}
        message="有尚未保存的修改"
        busy={app.busy}
        onDiscard={() => setDraft(app.data.settings)}
        onSave={() => void app.run(() => app.save(draft), "设置已保存")}
      />
    </div>
  );
}
