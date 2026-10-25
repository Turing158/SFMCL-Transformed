import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LoaderCircle, PackageOpen } from "lucide-react";
import { api, desktop } from "./api";
import { PixelFrame } from "./components";
import type { ModpackInspection, ModpackSource } from "./modpacks";
import { ModpackInstallDialog } from "./pages/ModpackInstallDialog";
import { useApp } from "./store";
import "./modpack-drop.css";

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
  const overlay = useRef<HTMLDivElement>(null);
  const visible = phase !== "idle";
  const [displayPhase, setDisplayPhase] = useState(phase);
  if (visible && displayPhase !== phase) setDisplayPhase(phase);
  const present = displayPhase !== "idle";

  useLayoutEffect(() => {
    const element = overlay.current;
    if (!present || !element) return;
    const open = element.matches(":popover-open");
    const from = open ? getComputedStyle(element).opacity : "0";
    const content = element.querySelector<HTMLElement>(".modpack-drop-content");
    const contentFrom =
      open && content
        ? getComputedStyle(content).transform
        : "translateY(12px) scale(0.99)";
    // Keep the popover in the top layer until its exit animation finishes.
    if (!open) element.showPopover();
    const timing = {
      duration: visible ? 240 : 200,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both" as FillMode,
    };
    const animations = [
      element.animate([{ opacity: from }, { opacity: visible ? 0.75 : 0 }], {
        ...timing,
        id: visible ? "sfmcl-t-modpack-drop-enter" : "sfmcl-t-modpack-drop-exit",
      }),
    ];
    if (content)
      animations.push(
        content.animate(
          [
            { transform: contentFrom },
            {
              transform: visible
                ? "translateY(0) scale(1)"
                : "translateY(8px) scale(0.99)",
            },
          ],
          { ...timing, id: "sfmcl-t-modpack-drop-content" },
        ),
      );
    let cancelled = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (cancelled || visible) return;
        element.hidePopover();
        setDisplayPhase("idle");
      },
      () => {},
    );
    return () => {
      cancelled = true;
      // Reversing a drag continues from the current opacity without a flash.
      element.style.opacity = getComputedStyle(element).opacity;
      if (content)
        content.style.transform = getComputedStyle(content).transform;
      animations.forEach((animation) => animation.cancel());
    };
  }, [present, visible]);

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
    const listener = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") {
        if (!checking.current) setPhase("idle");
        return;
      }
      if (payload.type === "enter" || payload.type === "over") {
        if (!checking.current) {
          if (payload.type === "enter") setPaths(payload.paths);
          setPhase("hover");
        }
        return;
      }
      if (checking.current) return;
      const dropped = payload.paths;
      setPaths(dropped);
      setPhase("idle");
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
      {present && (
        <div
          ref={overlay}
          popover="manual"
          className="modpack-drop-overlay"
          data-phase={displayPhase}
          data-exiting={!visible || undefined}
          role="status"
          aria-live="polite"
          aria-hidden={!visible || undefined}
          aria-busy={visible && displayPhase === "checking"}
        >
          <div className="modpack-drop-frame has-surface">
            <PixelFrame />
            <div className="modpack-drop-content">
              <span
                className="modpack-drop-icon has-surface"
                aria-hidden="true"
              >
                <PixelFrame />
                {displayPhase === "checking" ? (
                  <LoaderCircle className="spin" size={40} />
                ) : (
                  <PackageOpen size={40} />
                )}
              </span>
              <span className="modpack-drop-eyebrow">整合包安装</span>
              <h2>
                {displayPhase === "checking"
                  ? "正在校验整合包…"
                  : "松开以导入整合包"}
              </h2>
              <p>
                {displayPhase === "checking"
                  ? "正在检查包内清单与客户端文件"
                  : "拖入安装包，开始创建你的游戏实例"}
              </p>
              {fileName && (
                <strong
                  className="modpack-drop-filename"
                  data-tooltip={paths.join("\n")}
                >
                  {fileName}
                </strong>
              )}
              <p className="modpack-drop-formats">
                支持 MRPACK、ZIP、7Z、RAR、TAR、TAR.GZ 及客户端目录
              </p>
            </div>
            <span className="modpack-drop-hint">
              {displayPhase === "checking"
                ? "校验通过后进入安装设置"
                : "拖出窗口可取消"}
            </span>
          </div>
        </div>
      )}
      {source && installReady && (
        <ModpackInstallDialog
          initialSource={source}
          onClose={() => setSource(null)}
        />
      )}
    </>
  );
}
