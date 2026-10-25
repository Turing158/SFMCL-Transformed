import { Input, Select, Slider, Switch, Textarea } from "../controls";
import { useEffect, useState, type ReactNode } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useApp } from "../store";
import { api, pickJava } from "../api";
import { Button, PixelFrame } from "../components";
import { javaPathKey, mergeJavaPaths } from "../gameSettings";
import { useAvailableMemory } from "../useAvailableMemory";
import type {
  GameSettingGroup,
  GameSettingGroups,
  GameSettings,
  Java,
} from "../types";

function SettingsCard({
  group,
  title,
  groups,
  onGroupChange,
  busy,
  children,
}: {
  group: GameSettingGroup;
  title: string;
  groups?: GameSettingGroups;
  onGroupChange?: (group: GameSettingGroup, independent: boolean) => void;
  busy: boolean;
  children: ReactNode;
}) {
  const independent = groups?.[group];
  return (
    <section
      className="panel settings-section has-surface"
      data-setting-group={group}
      data-independent={independent}
    >
      <PixelFrame />
      <header className="settings-card-heading">
        <h2>{title}</h2>
        {groups && onGroupChange && (
          <Switch
            aria-label={`${title}：独立设置`}
            checked={!!independent}
            checkedLabel="独立"
            uncheckedLabel="全局"
            disabled={busy}
            onCheckedChange={(checked) => onGroupChange(group, checked)}
          />
        )}
      </header>
      <fieldset
        className="game-settings-fields settings-card-fields"
        disabled={busy || independent === false}
        aria-label={title}
      >
        {children}
      </fieldset>
    </section>
  );
}

export function GameSettingsFields({
  draft,
  setDraft,
  groups,
  onGroupChange,
  onJavaPathsSave,
}: {
  draft: GameSettings;
  setDraft: (update: (current: GameSettings) => GameSettings) => void;
  groups?: GameSettingGroups;
  onGroupChange?: (group: GameSettingGroup, independent: boolean) => void;
  onJavaPathsSave: (paths: string[], removedPath?: string) => Promise<string[]>;
}) {
  const app = useApp();
  const [java, setJava] = useState<Java[]>([]);
  const [javaInfoError, setJavaInfoError] = useState("");
  const {
    availableMb,
    error: memoryError,
    refreshing: refreshingMemory,
    refresh: refreshMemory,
  } = useAvailableMemory();
  const memoryMax = Math.min(availableMb ?? 131072, 131072);
  const memoryMin = Math.min(512, memoryMax);
  const memoryValue = Math.min(draft.memoryMb, memoryMax);
  const memoryDisabled =
    draft.autoMemory ||
    availableMb === null ||
    memoryMax < 512 ||
    !!memoryError;
  useEffect(() => {
    if (availableMb === null || groups?.memory === false) return;
    if (draft.memoryMb > memoryMax)
      setDraft((current) =>
        current.memoryMb > memoryMax
          ? { ...current, memoryMb: memoryMax }
          : current,
      );
  }, [availableMb, memoryMax, draft.memoryMb, groups?.memory, setDraft]);
  const javaPaths = mergeJavaPaths(
    draft.javaPaths,
    draft.javaPath ? [draft.javaPath] : [],
  );
  const selectedJavaPath =
    javaPaths.find(
      (path) => javaPathKey(path) === javaPathKey(draft.javaPath),
    ) ?? draft.javaPath;
  const savedJavaPaths = JSON.stringify(draft.javaPaths);
  useEffect(() => {
    let active = true;
    setJavaInfoError("");
    void api<Java[]>("java.list", { paths: JSON.parse(savedJavaPaths) })
      .then((values) => {
        if (active) setJava(values);
      })
      .catch(() => {
        if (active) setJavaInfoError("Java 版本信息读取失败，可重新扫描。");
      });
    return () => {
      active = false;
    };
  }, [savedJavaPaths]);
  const cardProps = { groups, onGroupChange, busy: app.busy };
  const change = <K extends keyof GameSettings>(
    key: K,
    value: GameSettings[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const toggle = (
    key: "autoMemory" | "isolation" | "fullscreen" | "jvmArgsEnabled",
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
    <div className="settings-stack">
      <SettingsCard group="java" title="Java 运行环境" {...cardProps}>
        <p>自动选择兼容版本；手动添加仅支持 java.exe 或 javaw.exe。</p>
        <div className="input-action">
          <Select
            aria-label="Java 运行环境"
            value={selectedJavaPath}
            disabled={groups?.java === false}
            onValueChange={(value) => {
              if (!app.busy) change("javaPath", value);
            }}
            onRemoveOption={(path) => {
              if (app.busy) return;
              void app.run(async () => {
                await onJavaPathsSave(
                  draft.javaPaths.filter(
                    (value) => javaPathKey(value) !== javaPathKey(path),
                  ),
                  path,
                );
                setJava((values) =>
                  values.filter(
                    (value) => javaPathKey(value.path) !== javaPathKey(path),
                  ),
                );
              });
            }}
            optionActionsDisabled={app.busy || groups?.java === false}
            removeOptionLabel={(path) => `从列表删除 ${path}`}
          >
            <option value="">自动选择适合游戏的 Java</option>
            {javaPaths.map((path) => (
              <option key={path} value={path}>
                {[
                  java.find((j) => javaPathKey(j.path) === javaPathKey(path))
                    ?.version,
                  path,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </option>
            ))}
          </Select>
          <Button
            disabled={app.busy}
            onClick={() =>
              void app.run(async () => {
                const values = await api<Java[]>("java.discover", {
                  paths: draft.javaPaths,
                });
                await onJavaPathsSave(
                  mergeJavaPaths(
                    draft.javaPaths,
                    values.map((value) => value.path),
                  ),
                );
                setJava(values);
              }, "Java 列表已保存")
            }
          >
            <RefreshCw size={16} />
            扫描
          </Button>
          <Button
            data-tooltip="仅支持选择 java.exe 或 javaw.exe"
            onClick={() =>
              void app.run(async () => {
                const path = await pickJava();
                if (path) {
                  const j = await api<Java>("java.probe", { path });
                  await onJavaPathsSave(
                    mergeJavaPaths(draft.javaPaths, [j.path]),
                  );
                  setJava((values) => [
                    ...values.filter((v) => v.path !== j.path),
                    j,
                  ]);
                  setDraft((d) => ({
                    ...d,
                    javaPath: j.path,
                  }));
                }
              })
            }
          >
            <FolderOpen size={16} />
            手动添加
          </Button>
        </div>
        {javaInfoError && (
          <p className="inline-error" role="alert">
            {javaInfoError}
          </p>
        )}
        {draft.javaPath && (
          <p className="helper">已选 Java：{draft.javaPath}</p>
        )}
      </SettingsCard>
      <SettingsCard group="memory" title="内存与游戏目录" {...cardProps}>
        {toggle(
          "autoMemory",
          "自动分配内存",
          "根据系统可用内存自动选择，最多使用 8 GB。",
        )}
        <div className="memory-control">
          <Slider
            aria-label="游戏内存"
            min={memoryMin}
            max={memoryMax}
            step={1}
            value={memoryValue}
            disabled={memoryDisabled}
            onChange={(e) => change("memoryMb", Number(e.target.value))}
            onKeyDown={(e) => {
              if (
                !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                  e.key,
                )
              )
                return;
              e.preventDefault();
              const delta =
                e.key === "ArrowRight" || e.key === "ArrowUp" ? 128 : -128;
              change(
                "memoryMb",
                Math.max(memoryMin, Math.min(memoryMax, memoryValue + delta)),
              );
            }}
          />
          <div className="memory-input-actions">
            <Button
              className="icon-button memory-refresh"
              aria-label="刷新内存上限"
              data-tooltip="刷新可用内存"
              aria-busy={refreshingMemory}
              disabled={refreshingMemory || app.busy}
              onClick={refreshMemory}
            >
              <RefreshCw
                size={16}
                className={refreshingMemory ? "spin" : undefined}
              />
            </Button>
            <label className="number-unit">
              <Input
                type="number"
                aria-label="内存 MB"
                min={memoryMin}
                max={memoryMax}
                value={memoryValue}
                disabled={memoryDisabled}
                onChange={(e) =>
                  change(
                    "memoryMb",
                    Math.min(memoryMax, e.target.valueAsNumber || 0),
                  )
                }
                onBlur={() =>
                  change("memoryMb", Math.max(memoryMin, memoryValue))
                }
              />
              <span>MB</span>
            </label>
          </div>
          <div className="memory-range-limits" aria-hidden="true">
            <span>{memoryMin} MB</span>
            <span>{availableMb === null ? "—" : memoryMax} MB</span>
          </div>
        </div>
        {(memoryError || memoryMax < 512) && (
          <p className="inline-error" role="alert">
            {memoryError || "当前可用内存不足 512 MB，请释放内存后重试。"}
          </p>
        )}
        {toggle(
          "isolation",
          "版本隔离",
          "每个版本分别保存模组、设置和存档。切换后不会自动移动已有文件。",
        )}
      </SettingsCard>
      <SettingsCard group="window" title="游戏窗口" {...cardProps}>
        {toggle("fullscreen", "全屏启动", "关闭后使用下方窗口尺寸。")}
        <div className="form-grid">
          <label className="field">
            宽度
            <Input
              type="number"
              min={320}
              max={16384}
              value={draft.width}
              onChange={(e) => change("width", Number(e.target.value))}
            />
          </label>
          <label className="field">
            高度
            <Input
              type="number"
              min={240}
              max={16384}
              value={draft.height}
              onChange={(e) => change("height", Number(e.target.value))}
            />
          </label>
          <label className="field">
            窗口标题
            <Input
              value={draft.windowTitle}
              onChange={(e) => change("windowTitle", e.target.value)}
              placeholder="保留游戏默认标题"
            />
          </label>
          <label className="field">
            自定义信息
            <Input
              value={draft.customInfo}
              onChange={(e) => change("customInfo", e.target.value)}
            />
          </label>
        </div>
      </SettingsCard>
      <SettingsCard group="advanced" title="高级启动参数" {...cardProps}>
        {toggle(
          "jvmArgsEnabled",
          "附加 JVM 参数",
          "参数直接传给 Java；含空格的值请用引号包围。",
        )}
        <label className="field">
          JVM 参数
          <Textarea
            disabled={!draft.jvmArgsEnabled}
            value={draft.jvmArgs}
            onChange={(e) => change("jvmArgs", e.target.value)}
            rows={3}
            placeholder="例如 -XX:+UseG1GC"
          />
        </label>
        <label className="field">
          游戏尾部参数
          <Textarea
            value={draft.gameArgs}
            onChange={(e) => change("gameArgs", e.target.value)}
            rows={2}
            placeholder="附加到游戏参数末尾"
          />
        </label>
      </SettingsCard>
    </div>
  );
}
