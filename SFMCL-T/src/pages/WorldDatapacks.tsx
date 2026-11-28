import { useEffect, useState } from "react";
import { Compass, FileUp, FolderOpen } from "lucide-react";
import { api, confirmAction, pick } from "../api";
import { Button, PixelFrame } from "../components";
import { LoadingState } from "../LoadingState";
import { MinecraftText } from "../MinecraftText";
import { usePageActive } from "../PageActivity";
import { useApp } from "../store";
import { useTaskSelector } from "../tasks";
import type { DatapackTarget } from "../types";

type Pack = {
  name: string;
  description: string;
  directory: boolean;
  state: "enabled" | "disabled" | "pending" | "unknown";
  error?: string;
};

type Inventory = { packs: Pack[]; stateError?: string };
type Action = "enable" | "disable" | "delete";

const stateLabels = {
  enabled: "已启用",
  disabled: "已禁用",
  pending: "待游戏加载",
  unknown: "状态未知",
};

export function WorldDatapacks({
  target,
  worldPath,
  onBrowse,
}: {
  target: DatapackTarget;
  worldPath: string;
  onBrowse: (trigger: HTMLButtonElement) => void;
}) {
  const app = useApp();
  const active = usePageActive();
  const { directory, versionId, worldId } = target;
  const [inventory, setInventory] = useState<Inventory>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const completed = useTaskSelector(
    ({ jobs }) =>
      jobs
        .filter(
          (job) => job.datapackWorld === worldPath && job.status === "completed",
        )
        .map((job) => job.id)
        .join(","),
  );

  useEffect(() => {
    if (!active) return;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void api<Inventory>("resources.datapacks.list", {
      target: { directory, versionId, worldId },
    })
      .then((result) => {
        if (!current) return;
        setInventory(result);
        setError("");
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [active, completed, directory, versionId, worldId, revision]);

  const refresh = () => setRevision((value) => value + 1);
  const importPack = () =>
    void app.run(async () => {
      const path = await pick(false, ["zip"], {
        title: "选择数据包",
        filterName: "数据包 ZIP",
      });
      if (!path) return;
      const installed = await api<boolean>("resources.datapacks.import", {
        target,
        path,
      });
      refresh();
      app.notify(installed ? "数据包已安装" : "存档已包含相同文件");
    });

  const edit = async (name: string, action: Action) => {
    if (
      action === "delete" &&
      !(await confirmAction(`删除数据包「${name}」？`))
    )
      return;
    await app.run(async () => {
      try {
        await api("resources.datapacks.edit", { target, name, action });
      } finally {
        refresh();
      }
    }, { enable: "数据包已启用", disable: "数据包已禁用", delete: "数据包已删除" }[action]);
  };

  return (
    <section
      className="world-datapacks has-surface"
      aria-labelledby="world-datapacks-title"
    >
      <PixelFrame />
      <div className="world-datapacks-header">
        <h2 id="world-datapacks-title">数据包</h2>
        <div className="world-datapacks-actions">
          <Button onClick={(event) => onBrowse(event.currentTarget)}>
            <Compass size={16} />
            浏览数据包
          </Button>
          <Button disabled={app.busy} onClick={importPack}>
            <FileUp size={16} />
            导入本地 ZIP
          </Button>
          <Button
            disabled={app.busy}
            onClick={() =>
              void app.run(() => api("resources.datapacks.open", { target }))
            }
          >
            <FolderOpen size={16} />
            打开数据包目录
          </Button>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <LoadingState loading={!inventory && !error} label="正在读取数据包">
        {inventory?.stateError && (
          <p className="inline-error" role="alert">
            {inventory.stateError}
          </p>
        )}
        {inventory?.packs.length === 0 && (
          <p className="helper">此存档暂无数据包。</p>
        )}
        {!!inventory?.packs.length && (
          <ul className="world-datapack-list">
            {inventory.packs.map((pack) => (
              <li key={pack.name} className="world-datapack-row">
                <div className="world-datapack-info">
                  <strong>{pack.name}</strong>
                  <small>
                    {pack.directory ? "文件夹" : "ZIP"} ·{" "}
                    {stateLabels[pack.state]}
                  </small>
                  {pack.description && (
                    <small>
                      <MinecraftText text={pack.description} />
                    </small>
                  )}
                  {pack.error && (
                    <small className="inline-error">{pack.error}</small>
                  )}
                </div>
                <div className="world-datapacks-actions">
                  {pack.state !== "enabled" && (
                    <Button
                      aria-label={`启用 ${pack.name}`}
                      disabled={
                        app.busy ||
                        !!error ||
                        pack.state === "unknown" ||
                        !!pack.error
                      }
                      onClick={() => void edit(pack.name, "enable")}
                    >
                      启用
                    </Button>
                  )}
                  {pack.state !== "disabled" && pack.state !== "unknown" && (
                    <Button
                      aria-label={`禁用 ${pack.name}`}
                      disabled={app.busy || !!error}
                      onClick={() => void edit(pack.name, "disable")}
                    >
                      禁用
                    </Button>
                  )}
                  <Button
                    aria-label={`删除 ${pack.name}`}
                    disabled={app.busy || !!error || pack.state === "unknown"}
                    onClick={() => void edit(pack.name, "delete")}
                  >
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </LoadingState>
    </section>
  );
}
