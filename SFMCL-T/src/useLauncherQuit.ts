import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmAction, desktop } from "./api";

type QuitEvent = { kind: "confirm" } | { kind: "error"; message: string };

export function useLauncherQuit(reportError: (message: string) => void) {
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let pending = false;
    const confirm = async () => {
      if (pending) return;
      pending = true;
      try {
        const confirmed = await confirmAction(
          "退出启动器将断开当前联机，确定要退出吗？",
        );
        await invoke("resolve_launcher_quit", { confirmed });
      } catch (error) {
        reportError(`无法退出启动器：${String(error)}`);
      } finally {
        pending = false;
      }
    };
    const listener = getCurrentWindow().listen<QuitEvent>(
      "sfmcl-t-quit",
      ({ payload }) => {
        if (disposed) return;
        if (payload.kind === "error") reportError(payload.message);
        else void confirm();
      },
    );
    const failed = (error: unknown) => {
      if (!disposed) reportError(`无法监听启动器退出请求：${String(error)}`);
    };
    void listener.catch(failed);
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [reportError]);
}
