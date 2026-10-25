import { Copy, FolderOpen } from "lucide-react";
import { Button, PixelFrame, ResourceImage } from "../components";
import { useApp } from "../store";
import type { LocalResource, Project, Version } from "../types";
import { ResourceSubpage } from "./ResourceSubpage";
import { LocalModChannels } from "./LocalModChannels";
import { localResourceSize, openLocalResource } from "../localResources";

export function LocalResourcePage({
  item,
  version,
  onOpenModProject,
}: {
  item: LocalResource;
  version: Version;
  onOpenModProject: (project: Project, trigger: HTMLButtonElement) => void;
}) {
  const app = useApp();
  const openFolder = () => void app.run(() => openLocalResource(item));
  const world = item.kind === "world";
  const tab = world ? "world" : "mod";
  const d = item.details;
  const rules =
    typeof d.gameRules === "object" && d.gameRules
      ? Object.entries(d.gameRules)
      : [];
  return (
    <div className="local-resource-page">
      <ResourceSubpage title={item.name} tab={tab}>
        <div className="project-heading">
          <ResourceImage path={item.icon} alt="" />
          <div>
            <p>{item.description || item.version}</p>
            <small className="path-text">{item.path}</small>
          </div>
          <div className="local-resource-detail-actions">
            {!world && (
              <LocalModChannels
                item={item}
                version={version}
                onOpen={onOpenModProject}
              />
            )}
            <Button onClick={openFolder}>
              <FolderOpen size={16} />
              打开所在目录
            </Button>
          </div>
        </div>
        {world ? (
          Object.keys(d).length > 0 && !item.error ? (
            <>
              <div className="world-details has-surface">
                <PixelFrame />
                {[
                  [
                    "游戏模式",
                    ["生存", "创造", "冒险", "旁观者"][Number(d.gameMode)] ||
                      "未知",
                  ],
                  [
                    "难度",
                    ["和平", "简单", "普通", "困难"][Number(d.difficulty)] ||
                      "未知",
                  ],
                  [
                    "天气",
                    d.raining ? (d.thundering ? "雷雨" : "雨天") : "晴天",
                  ],
                  ["允许作弊", d.allowCommands ? "是" : "否"],
                  ["极限模式", d.hardcore ? "是" : "否"],
                  ["奖励箱", d.bonusChest ? "是" : "否"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <small>{label}</small>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="seed-row">
                <span>
                  世界种子 <code>{String(d.seed || "0")}</code>
                </span>
                <Button
                  aria-label="复制世界种子"
                  onClick={() =>
                    void app.run(
                      () =>
                        navigator.clipboard.writeText(String(d.seed || "0")),
                      "种子已复制",
                    )
                  }
                >
                  <Copy size={16} />
                  复制
                </Button>
              </div>
              <h3>
                游戏规则 <small>点击复制 /gamerule 命令</small>
              </h3>
              <div className="gamerules">
                {rules.map(([key, value]) => (
                  <button
                    type="button"
                    key={key}
                    aria-label={`复制游戏规则 ${key}`}
                    onClick={() =>
                      void app.run(
                        () =>
                          navigator.clipboard.writeText(
                            `/gamerule ${key} ${String(value)}`,
                          ),
                        "游戏规则已复制",
                      )
                    }
                  >
                    <code>{key}</code>
                    <span>{String(value)}</span>
                    <Copy size={13} />
                  </button>
                ))}
              </div>
            </>
          ) : null
        ) : (
          <div className="world-details has-surface">
            <PixelFrame />
            <div>
              <small>作者</small>
              <strong>{item.authors || "未知"}</strong>
            </div>
            <div>
              <small>版本</small>
              <strong>{item.version || "未声明"}</strong>
            </div>
            <div>
              <small>文件大小</small>
              <strong>{localResourceSize(item)}</strong>
            </div>
          </div>
        )}
        {item.error && (
          <p className="inline-error" role="alert">
            {item.error}
          </p>
        )}
      </ResourceSubpage>
    </div>
  );
}
