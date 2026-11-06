import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Globe } from "lucide-react";
import { desktop } from "./api";
import { DropOverlay, useDropOverlay } from "./DropOverlay";
import { useApp } from "./store";
import { parseYggdrasilDrop, readYggdrasilDrop } from "./yggdrasilDrop";

interface NativeCardDrop {
  phase: "enter" | "leave" | "drop";
  text?: string;
}

export function YggdrasilDropTarget() {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  const [hover, setHover] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const motion = useDropOverlay(hover ? "hover" : "idle", "yggdrasil");

  useLayoutEffect(() => {
    if (!pending || motion.present) return;
    latest.current.navigate({
      page: "players",
      login: "yggdrasil",
      yggdrasilImport: { server: pending, id: crypto.randomUUID() },
    });
    setPending(null);
    pendingRef.current = false;
  }, [pending, motion.present]);

  useEffect(() => {
    let disposed = false;
    let depth = 0;
    let internal = false;
    const reset = () => {
      depth = 0;
      setHover(false);
    };
    const accept = (server: string) => {
      const current = latest.current;
      if (!current.initialized || pendingRef.current) return;
      if (
        current.busy ||
        document.querySelector('[data-auth-busy="true"], dialog[open]')
      ) {
        current.reportError("请先完成或取消当前操作，再拖入外置登录卡片。");
        return;
      }
      pendingRef.current = true;
      setPending(server);
    };
    const start = (event: DragEvent) => {
      internal = true;
      queueMicrotask(() => {
        if (event.defaultPrevented) internal = false;
      });
    };
    const end = () => {
      internal = false;
      reset();
    };
    const textDrag = (event: DragEvent) =>
      !internal &&
      !!event.dataTransfer &&
      !Array.from(event.dataTransfer.types).includes("Files") &&
      ["text/plain", "text/uri-list", "text/x-moz-url"].some((type) =>
        Array.from(event.dataTransfer!.types).includes(type),
      );
    const enter = (event: DragEvent) => {
      if (!textDrag(event) || pendingRef.current) return;
      event.preventDefault();
      depth++;
      setHover(true);
    };
    const over = (event: DragEvent) => {
      if (!textDrag(event)) return;
      // Browsers protect the payload until drop. Do not navigate to dropped URLs.
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const leave = () => {
      if (--depth <= 0) reset();
    };
    const drop = (event: DragEvent) => {
      reset();
      if (!textDrag(event)) return;
      event.preventDefault();
      try {
        const server = readYggdrasilDrop(event.dataTransfer!);
        if (server) {
          event.stopPropagation();
          accept(server);
        }
      } catch (error) {
        latest.current.reportError(String(error));
      }
    };
    window.addEventListener("dragstart", start, true);
    window.addEventListener("dragend", end, true);
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("blur", end);
    const listener = desktop
      ? getCurrentWebview().listen<NativeCardDrop>(
          "yggdrasil-card-drop",
          ({ payload }) => {
            if (disposed) return;
            reset();
            if (payload.phase === "enter" && !pendingRef.current)
              setHover(true);
            if (payload.phase === "drop") {
              try {
                const server = parseYggdrasilDrop(payload.text ?? "");
                if (server) accept(server);
              } catch (error) {
                latest.current.reportError(String(error));
              }
            }
          },
        )
      : null;
    void listener?.catch((error) => {
      if (!disposed)
        latest.current.reportError(
          `无法启用外置登录卡片拖入：${String(error)}`,
        );
    });
    return () => {
      disposed = true;
      window.removeEventListener("dragstart", start, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("blur", end);
      void listener?.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return (
    <DropOverlay
      motion={motion}
      kind="yggdrasil"
      icon={<Globe size={40} />}
      eyebrow="外置登录"
      title="松开以登录验证站点"
      description="拖入外置登录链接，连接你的皮肤站账号"
      formats="自动配置验证服务器，随后进入站点登录页面"
      hint="拖出窗口可取消"
    />
  );
}
