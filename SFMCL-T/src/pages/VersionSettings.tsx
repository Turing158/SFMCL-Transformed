import { useEffect, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { PageHeader } from "../PageHeader";
import { api, confirmAction } from "../api";
import { Button, PixelFrame } from "../components";
import {
  independentGroups,
  resolveGameSettings,
  withJavaPaths,
} from "../gameSettings";
import { useApp } from "../store";
import type { Version, VersionSettings } from "../types";
import { GameSettingsFields } from "./GameSettingsFields";
import { SaveBar, SaveButton } from "../SaveBar";

export function VersionSettingsPage({ version }: { version: Version }) {
  const app = useApp();
  const [saved, setSaved] = useState<VersionSettings | null>(null);
  const [draft, setDraft] = useState<VersionSettings | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const { setNavigationGuard } = app;

  useEffect(() => {
    setNavigationGuard(
      "versions",
      () =>
        !app.busy &&
        (!dirty ||
          confirmAction("此版本有尚未保存的游戏设置，放弃修改并返回？")),
    );
    return () => setNavigationGuard("versions", null);
  }, [app.busy, dirty, setNavigationGuard]);

  useEffect(() => {
    let active = true;
    setSaved(null);
    setDraft(null);
    setError("");
    void api<VersionSettings>("versions.settings.get", {
      id: version.id,
      directory: version.directory,
    })
      .then((value) => {
        if (active) {
          setSaved(value);
          setDraft(value);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [version.id, version.directory, revision]);

  const save = () =>
    void app.run(async () => {
      if (!draft) return;
      const value = await api<VersionSettings>("versions.settings.save", {
        id: version.id,
        directory: version.directory,
        config: draft,
      });
      setSaved(value);
      setDraft(value);
      await app.refresh();
    }, "版本游戏设置已保存");

  return (
    <div className="version-settings-page">
      <PageHeader
        icon={<Settings2 />}
        eyebrow="GAME SETTINGS"
        title="游戏设置"
        description={version.id}
        action={
          <SaveButton
            showIndicator
            disabled={!dirty || app.busy}
            onSave={save}
          />
        }
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
          draft={resolveGameSettings(draft, app.data.settings)}
          onJavaPathsSave={async (paths, removedPath) => {
            const savedPaths = await api<string[]>("java.paths.save", {
              versionId: version.id,
              directory: version.directory,
              paths,
              removedPath,
            });
            const apply = (current: VersionSettings | null) =>
              current && {
                ...current,
                settings: withJavaPaths(
                  current.settings,
                  savedPaths,
                  removedPath,
                ),
              };
            setSaved(apply);
            setDraft(apply);
            return savedPaths;
          }}
          groups={independentGroups(draft)}
          onGroupChange={(group, independent) =>
            setDraft((current) => {
              if (!current) return current;
              const groups = {
                ...independentGroups(current),
                [group]: independent,
              };
              return {
                ...current,
                independentGroups: groups,
                useGlobal: !Object.values(groups).some(Boolean),
              };
            })
          }
          setDraft={(update) =>
            setDraft(
              (current) =>
                current && { ...current, settings: update(current.settings) },
            )
          }
        />
      )}
      <SaveBar
        visible={dirty}
        message="此版本有尚未保存的修改"
        busy={app.busy}
        onDiscard={() => setDraft(saved)}
        onSave={save}
      />
    </div>
  );
}
