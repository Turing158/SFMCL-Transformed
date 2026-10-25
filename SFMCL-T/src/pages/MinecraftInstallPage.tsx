import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { Input, Select } from "../controls";
import { Button, PixelFrame } from "../components";
import { MinecraftTypeIcon } from "./MinecraftTypeIcon";
import { ResourceSubpage } from "./ResourceSubpage";
import { InstallComponentCard } from "./InstallComponentCard";
import { useInstallCatalog } from "./useInstallCatalog";
import { api } from "../api";
import { gameDirectoryPath } from "../gameDirectories";
import {
  availableLoaderChoices,
  componentBlockReason,
  emptyInstallSelection,
  installSelectionPayload,
  selectInstallLoader,
  type InstallComponent,
} from "../installOptions";
import { useApp } from "../store";
import type { ManifestVersion } from "../types";

const components: {
  kind: InstallComponent;
  name: string;
  icon: string;
  description: string;
}[] = [
  {
    kind: "Forge",
    name: "Forge",
    icon: "Forge",
    description: "模组加载器 · 可搭配兼容的 OptiFine",
  },
  {
    kind: "OptiFine",
    name: "OptiFine",
    icon: "Optifine",
    description: "画面优化与光影 · 支持独立安装",
  },
  {
    kind: "Fabric",
    name: "Fabric",
    icon: "Fabric",
    description: "轻量模组加载器",
  },
  {
    kind: "FabricAPI",
    name: "Fabric API",
    icon: "Fabric",
    description: "Fabric 模组常用的前置组件",
  },
  {
    kind: "NeoForge",
    name: "NeoForge",
    icon: "NeoForge",
    description: "NeoForge 模组加载器",
  },
  {
    kind: "Quilt",
    name: "Quilt",
    icon: "quiltmc",
    description: "Quilt 模组加载器",
  },
  {
    kind: "LiteLoader",
    name: "LiteLoader",
    icon: "LiteLoader",
    description: "适用于旧版 Minecraft 的轻量加载器",
  },
];

export function MinecraftInstallPage({
  version,
  onBack,
}: {
  version: ManifestVersion;
  onBack: () => void;
}) {
  const app = useApp();
  const settings = app.data.settings;
  const [directory, setDirectory] = useState<string | null>(null);
  const root =
    directory ?? (settings.activeDir || settings.gameDirs[0]?.path || "");
  const [name, setName] = useState(version.id);
  const [selection, setSelection] = useState(emptyInstallSelection);
  const { catalogs, retry } = useInstallCatalog(version.id);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectedValue = (kind: InstallComponent) =>
    kind === "FabricAPI"
      ? selection.fabricApi?.id
      : kind === "OptiFine"
        ? selection.optifine?.version
        : selection.loader?.kind === kind
          ? selection.loader.version
          : undefined;
  const selectedComponents = components.filter((component) =>
    selectedValue(component.kind),
  );
  const waiting = selectedComponents.some(
    (component) => catalogs[component.kind].loading,
  );
  const unavailable = selectedComponents.find(
    (component) =>
      !catalogs[component.kind].loading &&
      !catalogs[component.kind].choices.some(
        (choice) => choice.value === selectedValue(component.kind),
      ),
  );
  const disabled =
    app.busy || !name.trim() || !root || waiting || !!unavailable;
  return (
    <ResourceSubpage title={`安装 Minecraft ${version.id}`} tab="minecraft">
      <form
        className="minecraft-install-options"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          void app.run(async () => {
            await api("install", {
              minecraft: version.id,
              name: name.trim(),
              root,
              ...installSelectionPayload(selection),
            });
            if (mounted.current) app.setPage("downloads");
          });
        }}
      >
        <div className="minecraft-version-heading">
          <MinecraftTypeIcon version={version} />
          <div>
            <strong>{version.id}</strong>
            <small>Mojang · {version.releaseTime.slice(0, 10)}</small>
          </div>
        </div>
        <div className="minecraft-install-basics">
          <label className="field">
            版本名称
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="自定义版本名称"
            />
          </label>
          {settings.gameDirs.length > 0 ? (
            <label className="field">
              安装目录
              <Select
                aria-label="安装目录"
                aria-describedby="minecraft-install-directory"
                value={root}
                onValueChange={setDirectory}
              >
                {settings.gameDirs.map((directory) => (
                  <option key={directory.path} value={directory.path}>
                    {directory.name || gameDirectoryPath(directory.path)}
                  </option>
                ))}
              </Select>
              <small id="minecraft-install-directory" className="path-text">
                {gameDirectoryPath(root)}
              </small>
            </label>
          ) : (
            <div className="info-note has-surface minecraft-directory-empty">
              <PixelFrame />
              <FolderOpen size={17} />
              <p>先添加一个游戏目录，再安装 Minecraft。</p>
              <Button onClick={() => app.setPage("versions")}>
                添加游戏目录
              </Button>
            </div>
          )}
        </div>
        <div className="minecraft-components-title">
          <h2>加载器与组件</h2>
          <p>不选择组件时安装原版。展开卡片选择版本，可同时添加兼容组件。</p>
        </div>
        <div className="minecraft-components">
          {components.map((component) => {
            const { kind } = component;
            const catalog = catalogs[kind];
            const available =
              kind === "FabricAPI"
                ? catalog.choices
                : catalog.choices.filter(
                    (choice) =>
                      choice.loader &&
                      availableLoaderChoices(kind, [choice.loader], selection)
                        .length,
                  );
            const value = selectedValue(kind) ?? "";
            const emptyMessage =
              kind === "OptiFine" && selection.loader?.kind === "Forge"
                ? `暂无匹配 Forge ${selection.loader.version} 的 OptiFine，可先取消 Forge 再选择其他组合。`
                : kind === "Forge" && selection.optifine
                  ? "暂无匹配所选 OptiFine 的 Forge 版本。"
                  : `此 Minecraft 版本暂无可用的 ${component.name}。`;
            return (
              <InstallComponentCard
                key={kind}
                name={component.name}
                icon={`/assets/DefaultGameIcon/${component.icon}.png`}
                description={component.description}
                choices={available}
                value={value}
                selectedLabel={
                  value
                    ? `已选择 ${kind === "FabricAPI" ? selection.fabricApi?.version : value}`
                    : undefined
                }
                blocked={componentBlockReason(kind, selection)}
                loading={catalog.loading}
                error={catalog.error}
                emptyMessage={emptyMessage}
                disabled={app.busy}
                onRetry={() => retry(kind)}
                onChange={(next) => {
                  if (app.busy) return;
                  const choice = available.find(
                    (choice) => choice.value === next,
                  );
                  if (next && !choice) return;
                  setSelection((current) =>
                    kind === "FabricAPI"
                      ? componentBlockReason(kind, current)
                        ? current
                        : { ...current, fabricApi: choice?.file ?? null }
                      : selectInstallLoader(
                          current,
                          kind,
                          choice?.loader ?? null,
                        ),
                  );
                }}
              />
            );
          })}
        </div>
        <div
          className="minecraft-install-summary"
          role="status"
          aria-live="polite"
        >
          <strong>安装内容</strong>
          <p>
            Minecraft {version.id}
            {selectedComponents
              .map(
                (component) =>
                  ` + ${component.name} ${component.kind === "FabricAPI" ? selection.fabricApi?.version : selectedValue(component.kind)}`,
              )
              .join("")}
          </p>
          {selection.loader?.kind === "Forge" && selection.optifine && (
            <small>
              先安装 Forge，再将对应的 OptiFine 模组安装到游戏的 mods 目录。
            </small>
          )}
          {!selection.loader && selection.optifine && (
            <small>将 OptiFine 安装为独立版本，无需 Forge。</small>
          )}
          {selection.fabricApi && (
            <small>Fabric API 将安装到游戏的 mods 目录。</small>
          )}
        </div>
        {unavailable && (
          <p className="inline-error" role="alert">
            所选 {unavailable.name} 版本当前不可用，请重新选择或重试获取列表。
          </p>
        )}
        <div className="resource-page-actions">
          <Button onClick={onBack}>取消</Button>
          <Button primary type="submit" disabled={disabled}>
            <Download size={17} />
            开始安装
          </Button>
        </div>
      </form>
    </ResourceSubpage>
  );
}
