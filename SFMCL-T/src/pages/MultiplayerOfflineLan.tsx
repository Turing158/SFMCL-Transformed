import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen } from "lucide-react";
import { api } from "../api";
import { Button, Modal } from "../components";
import { Switch } from "../controls";
import { usePageActive } from "../PageActivity";
import { independentGroups, launchSettingDefaults } from "../gameSettings";
import { useApp } from "../store";
import {
  offlineLanModLoader,
  offlineLanProject,
  offlineLanVersionDetails,
} from "../offlineLan";
import type { Version, VersionSettings } from "../types";

export function MultiplayerOfflineLan({
  version,
  disabled,
}: {
  version?: Pick<Version, "id" | "directory"> &
    Partial<Pick<Version, "loader" | "version">>;
  disabled: boolean;
}) {
  const app = useApp();
  const pageActive = usePageActive();
  // The parent keys this control by the selected host's directory and version.
  const target = useRef(version).current;
  const id = useId();
  const [config, setConfig] = useState<VersionSettings | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<boolean | null>(null);
  const [details, setDetails] = useState<{
    loader: string;
    version: string;
  } | null>(null);
  const [tutorial, setTutorial] = useState(false);
  const { loadVersionSettings } = app;

  useEffect(() => {
    setConfig(null);
    setDetails(null);
    setError(false);
    if (!pageActive) setTutorial(false);
    if (!target || !pageActive) return;
    let active = true;
    void Promise.all([
      loadVersionSettings(target),
      target.loader
        ? Promise.resolve({
            loader: target.loader,
            version: target.version ?? "",
          })
        : api<Parameters<typeof offlineLanVersionDetails>[0]>(
            "versions.detail",
            target,
          ).then(offlineLanVersionDetails),
    ])
      .then(([value, metadata]) => {
        if (active) {
          setConfig(value);
          setDetails(metadata);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [target, loadVersionSettings, pageActive, revision]);

  const independent = !!config && independentGroups(config).advanced;
  const loader = target?.loader ?? details?.loader;
  const gameVersion = target?.version ?? details?.version ?? "";
  const modded = !!loader && offlineLanModLoader(loader);
  const checked = independent
    ? (config.settings.offlineLan ?? launchSettingDefaults.offlineLan)
    : (app.data.settings.offlineLan ?? launchSettingDefaults.offlineLan);
  async function change(value: boolean) {
    setPending(value);
    try {
      if (target && config && independent) {
        const saved = await app.autoSaveVersionSettings(target, config, {
          ...config,
          settings: { ...config.settings, offlineLan: value },
        });
        setConfig(saved);
      } else {
        await app.autoSaveSettings(app.data.settings, {
          ...app.data.settings,
          offlineLan: value,
        });
      }
      app.notify("重启游戏后生效");
    } catch (reason) {
      app.reportError(`离线联机设置保存失败：${String(reason)}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="multiplayer-offline-lan" data-saving={pending !== null}>
      {!modded && <label htmlFor={id}>离线联机</label>}
      {error && (
        <button
          type="button"
          className="multiplayer-offline-lan-retry"
          disabled={disabled}
          onClick={() => setRevision((v) => v + 1)}
        >
          读取失败，重试
        </button>
      )}
      {modded ? (
        <Button
          disabled={disabled}
          aria-haspopup="dialog"
          data-tooltip="安装模组以允许离线账号加入局域网"
          onClick={() => setTutorial(true)}
        >
          <BookOpen size={16} />
          离线联机
        </Button>
      ) : (
        <Switch
          id={id}
          checked={pending ?? checked}
          disabled={disabled || pending !== null || (!!target && !config)}
          aria-label="允许离线账号加入局域网"
          data-tooltip="允许离线账号加入局域网"
          onCheckedChange={(value) => void change(value)}
        />
      )}
      {tutorial && modded && target && (
        <Modal
          title="离线联机安装教程"
          className="multiplayer-offline-lan-guide"
          descriptionId={`${id}-guide-version`}
          onClose={() => setTutorial(false)}
        >
          {(requestClose) => (
            <>
              <p id={`${id}-guide-version`}>
                当前游戏：{target.id} · {gameVersion} · {loader}
              </p>
              <p>
                在房主的游戏中安装 <strong>LAN World Plug-n-Play</strong>，
                通过模组设置允许离线角色加入局域网世界。
              </p>
              <ol className="multiplayer-offline-lan-steps">
                <li>
                  <strong>安装匹配的模组</strong>
                  <p>
                    点击“前往模组页面”，选择与 {gameVersion} 和 {loader}
                    匹配的文件，安装到当前游戏版本，并按下载页补齐依赖。
                  </p>
                </li>
                <li>
                  <strong>关闭游戏内的正版验证</strong>
                  <p>
                    重启 Minecraft，进入存档，按 Esc 打开“对局域网开放”。
                    将模组提供的“正版验证”设为“禁用”；需要保留正版 UUID
                    时可使用“禁用 + 修复UUID”。
                  </p>
                </li>
                <li>
                  <strong>开放世界并创建房间</strong>
                  <p>
                    对局域网开放后，返回启动器创建房间，再把邀请码发给好友。
                    每位玩家应使用不同的角色名。
                  </p>
                </li>
              </ol>
              <p className="helper">
                模组支持 Forge、NeoForge、Fabric 和 Quilt。
                如果下载页没有匹配文件，请选择模组支持的游戏版本和加载器。
              </p>
              <div className="dialog-actions">
                <Button onClick={requestClose}>关闭</Button>
                <Button
                  primary
                  onClick={() => {
                    setTutorial(false);
                    app.navigate({
                      page: "resources",
                      tab: "mod",
                      returnTo: { page: "multiplayer" },
                      resource: {
                        kind: "project",
                        project: offlineLanProject,
                        initialTab: "files",
                        gameVersion,
                        loader: loader.toLowerCase(),
                      },
                    });
                  }}
                >
                  前往模组页面
                  <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
