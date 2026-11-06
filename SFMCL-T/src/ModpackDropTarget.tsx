import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LoaderCircle, PackageOpen } from "lucide-react";
import { api, desktop } from "./api";
import { DropOverlay, useDropOverlay } from "./DropOverlay";
import type { ModpackInspection, ModpackSource } from "./modpacks";
import { ModpackInstallDialog } from "./pages/ModpackInstallDialog";
import { useApp } from "./store";

export function ModpackDropTarget() {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  const [phase, setPhase] = useState<"idle" | "hover" | "checking">("idle");
  const [paths, setPaths] = useState<string[]>([]);
  const [source, setSource] = useState<ModpackSource | null>(null);
  const [installReady, setInstallReady] = useState(false);
  const pendingSource = useRef<ModpackSource | null>(null);
  const checking = useRef(false);
  const motion = useDropOverlay(phase, "modpack");
  const { present, displayPhase } = motion;

  useLayoutEffect(() => {
    if (source && !present) {
      pendingSource.current = null;
      checking.current = false;
      setInstallReady(true);
    }
  }, [source, present]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let draggingFiles = false;
    const listener = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") {
        draggingFiles = false;
        if (!checking.current) setPhase("idle");
        return;
      }
      if (payload.type === "enter") {
        if (!checking.current) {
          draggingFiles = payload.paths.length > 0;
          setPaths(payload.paths);
          setPhase(draggingFiles ? "hover" : "idle");
        }
        return;
      }
      if (payload.type === "over") {
        // WebView2 may keep emitting over events for text after a file drag.
        // Only an active enter with file paths can show the import overlay.
        if (draggingFiles && !checking.current) setPhase("hover");
        return;
      }
      draggingFiles = false;
      if (checking.current) return;
      const dropped = payload.paths;
      setPhase("idle");
      if (!dropped.length) return;
      setPaths(dropped);
      const busy = latest.current.busy;
      checking.current = true;
      void latest.current.run(async () => {
        try {
          if (dropped.length !== 1)
            throw new Error("请一次拖入一个整合包安装文件或客户端目录");
          if (busy) throw new Error("当前操作正在处理中，请稍后再拖入整合包");
          if (document.querySelector("dialog[open]"))
            throw new Error("请先关闭当前对话框，再拖入整合包");
          setPhase("checking");
          let inspection: ModpackInspection;
          try {
            inspection = await api<ModpackInspection>("modpacks.inspect", {
              path: dropped[0],
            });
          } catch (error) {
            throw new Error(
              `无法导入整合包：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (disposed) {
            await api("modpacks.discard", { token: inspection.token });
            return;
          }
          if (document.querySelector("dialog[open]")) {
            await api("modpacks.discard", { token: inspection.token });
            throw new Error("请先关闭当前对话框，再拖入整合包");
          }
          const prepared = { path: dropped[0], inspection };
          pendingSource.current = prepared;
          setInstallReady(false);
          setSource(prepared);
        } finally {
          checking.current = pendingSource.current !== null;
          if (!disposed) setPhase("idle");
        }
      });
    });
    void listener.catch((error) => {
      if (!disposed)
        void latest.current.run(async () => {
          throw new Error(`无法启用文件拖入：${String(error)}`);
        });
    });
    return () => {
      disposed = true;
      if (pendingSource.current) {
        void api("modpacks.discard", {
          token: pendingSource.current.inspection.token,
        }).catch(() => {});
        pendingSource.current = null;
      }
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const fileName =
    paths.length > 1
      ? `已拖入 ${paths.length} 个文件，请一次选择一个整合包`
      : paths[0]?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <>
      <DropOverlay
        motion={motion}
        kind="modpack"
        icon={
          displayPhase === "checking" ? (
            <LoaderCircle className="spin" size={40} />
          ) : (
            <PackageOpen size={40} />
          )
        }
        eyebrow="整合包安装"
        title={
          displayPhase === "checking" ? "正在校验整合包…" : "松开以导入整合包"
        }
        description={
          displayPhase === "checking"
            ? "正在检查包内清单与客户端文件"
            : "拖入安装包，开始创建你的游戏实例"
        }
        detail={fileName}
        detailTooltip={paths.join("\n")}
        formats="支持 MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ 及客户端目录"
        hint={
          displayPhase === "checking"
            ? "校验通过后进入安装设置"
            : "拖出窗口可取消"
        }
      />
      {source && installReady && (
        <ModpackInstallDialog
          initialSource={source}
          onClose={() => setSource(null)}
        />
      )}
    </>
  );
}
