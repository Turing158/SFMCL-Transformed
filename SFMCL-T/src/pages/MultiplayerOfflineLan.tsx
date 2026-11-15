import { useEffect, useId, useRef, useState } from "react";
import { Switch } from "../controls";
import { usePageActive } from "../PageActivity";
import { independentGroups, launchSettingDefaults } from "../gameSettings";
import { useApp } from "../store";
import type { Version, VersionSettings } from "../types";

export function MultiplayerOfflineLan({
  version,
  disabled,
}: {
  version?: Pick<Version, "id" | "directory">;
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
  const { loadVersionSettings } = app;

  useEffect(() => {
    setConfig(null);
    setError(false);
    if (!target || !pageActive) return;
    let active = true;
    void loadVersionSettings(target)
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [target, loadVersionSettings, pageActive, revision]);

  const independent = !!config && independentGroups(config).advanced;
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
      <label htmlFor={id}>离线联机</label>
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
      <Switch
        id={id}
        checked={pending ?? checked}
        disabled={disabled || pending !== null || (!!target && !config)}
        aria-label="允许离线账号加入局域网"
        data-tooltip="允许离线账号加入局域网"
        onCheckedChange={(value) => void change(value)}
      />
    </div>
  );
}
