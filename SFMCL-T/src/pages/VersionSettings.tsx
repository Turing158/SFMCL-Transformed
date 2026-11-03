import { useEffect, useRef, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { PageHeader } from "../PageHeader";
import { Button, PixelFrame } from "../components";
import {
  independentGroups,
  resolveGameSettings,
  withJavaPaths,
  prepareVersionSettings,
  updateVersionGameSettings,
  updateVersionSettingGroup,
} from "../gameSettings";
import { useApp } from "../store";
import type { Version, VersionSettings } from "../types";
import { GameSettingsFields } from "./GameSettingsFields";
import { useAutoSavedSettings } from "../useAutoSavedSettings";

export function VersionSettingsPage({ version }: { version: Version }) {
  const app = useApp();
  const [saved, setSaved] = useState<VersionSettings | null>(null);
  const target = useRef({
    ...version,
    directory: version.directory ?? app.data.settings.activeDir,
  }).current;
  const autoSave = useAutoSavedSettings(
    saved,
    (previous, next) => app.autoSaveVersionSettings(target, previous, next),
    prepareVersionSettings,
    (error) => app.reportError(`版本设置自动保存失败：${String(error)}`),
  );
  const { draft, setDraft } = autoSave;
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setSaved(null);
    setError("");
    void app
      .loadVersionSettings(target)
      .then((value) => {
        if (active) {
          setSaved(value);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [target, app.loadVersionSettings, revision]);

  return (
    <div className="version-settings-page" data-saving={autoSave.saving}>
      <PageHeader
        icon={<Settings2 />}
        eyebrow="GAME SETTINGS"
        title="游戏设置"
        description={version.id}
      />
      {error ? (
        <section className="panel settings-section has-surface" role="alert">
          <PixelFrame />
          <p className="inline-error">{error}</p>
          <Button onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={16} />
            重试
          </Button>
        </section>
      ) : !draft ? (
        <p role="status">正在读取版本设置…</p>
      ) : (
        <GameSettingsFields
          version={target}
          draft={resolveGameSettings(draft, app.data.settings)}
          onJavaPathsSave={async (paths, removedPath) => {
            const savedPaths = await app.saveJavaPaths(
              paths,
              removedPath,
              target,
            );
            autoSave.sync((current) => ({
              ...current,
              settings: withJavaPaths(
                current.settings,
                savedPaths,
                removedPath,
              ),
            }));
            return savedPaths;
          }}
          groups={independentGroups(draft)}
          onGroupChange={(group, independent) =>
            setDraft((current) =>
              updateVersionSettingGroup(current, group, independent),
            )
          }
          setDraft={(update) =>
            setDraft((current) =>
              updateVersionGameSettings(current, update(current.settings)),
            )
          }
        />
      )}
    </div>
  );
}
