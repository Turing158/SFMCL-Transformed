import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readSurfacePose,
  revealDuration,
  surfaceMotionFrames,
  visibleSurface,
} from "./surfaceMotion";

type WindowAction = "minimize" | "hide" | "show";
interface WindowTransition {
  id: number;
  action: WindowAction;
}

const concealed = {
  minimize: { scale: 0.93, y: 3, opacity: 0 },
  hide: { scale: 0.975, y: 0, opacity: 0 },
};
const exitDuration = { minimize: 120, hide: 100 };

export function minimizeWindow() {
  return invoke("minimize_window");
}

// The body includes React portals, so menus and dialogs travel with the window.
// Only a concealed window keeps its effect; visible windows release transforms
// to restore the usual containing block for fixed popovers and dialogs.
export function initializeWindowMotion() {
  if (!isTauri()) return () => {};
  const currentWindow = getCurrentWindow();
  let animation: Animation | undefined;
  let revision = 0;
  let hidden = false;
  let lastAction: "minimize" | "hide" = "hide";
  let active: WindowAction | undefined;
  let disposed = false;

  const reset = () => {
    animation?.cancel();
    animation = undefined;
    active = undefined;
    hidden = false;
    delete document.documentElement.dataset.windowMotion;
  };
  const animate = (action: WindowAction) => {
    const start = animation
      ? readSurfacePose(document.body)
      : action === "show"
        ? concealed[lastAction]
        : visibleSurface;
    animation?.cancel();
    document.documentElement.dataset.windowMotion = action;
    animation = document.body.animate(
      surfaceMotionFrames(
        start,
        action === "show" ? visibleSurface : concealed[action],
        action === "show",
      ),
      {
        id: `sfmcl-t-window-${action}`,
        duration: action === "show" ? revealDuration : exitDuration[action],
        // The sampled keyframes already contain the easing for each property.
        easing: "linear",
        fill: "both",
      },
    );
    return animation;
  };
  const transition = async ({ id, action }: WindowTransition) => {
    if (disposed) return;
    const token = ++revision;
    active = action;
    const motion = animate(action);
    // Prepare the transparent first frame before restoring the native window.
    if (action === "show") motion.pause();
    try {
      if (action !== "show") await motion.finished;
      if (token !== revision) return;
      const applied = await invoke<boolean>("complete_window_transition", {
        id,
      });
      if (token !== revision) return;
      if (!applied) {
        reset();
        return;
      }
      if (action === "show") {
        motion.play();
        await motion.finished;
        if (token === revision) {
          reset();
          await invoke("finish_window_transition", { id });
        }
      } else {
        lastAction = action;
        hidden = true;
        active = undefined;
        // Windows can restore during a fallback or before the IPC reply arrives.
        void restore();
      }
    } catch (error) {
      if (token !== revision || disposed) return;
      reset();
      await invoke("finish_window_transition", { id, cancel: true }).catch(
        console.error,
      );
      console.error("无法切换窗口状态", error);
    }
  };
  const restore = async () => {
    if (disposed || active || !hidden || document.hidden) return;
    const token = ++revision;
    active = "show";
    try {
      const [visible, minimized] = await Promise.all([
        currentWindow.isVisible(),
        currentWindow.isMinimized(),
      ]);
      if (disposed || token !== revision) return;
      if (document.hidden || !visible || minimized) {
        active = undefined;
        return;
      }
      await animate("show").finished;
      if (revision === token) {
        reset();
        await invoke("finish_window_transition", { id: null });
      }
    } catch (error) {
      if (token === revision) reset();
      console.error("无法恢复窗口动画", error);
    }
  };
  const visibilityChanged = () => {
    if (document.documentElement.hasAttribute("data-startup")) return;
    if (document.hidden && !active && !hidden) {
      // System shortcuts can minimize without going through the titlebar.
      // Keep a transparent frame ready for the taskbar's restore operation.
      ++revision;
      lastAction = "minimize";
      hidden = true;
      const motion = animate("minimize");
      motion.finish();
    } else {
      void restore();
    }
  };
  const nativeStateChanged = async () => {
    if (
      disposed ||
      active ||
      document.documentElement.hasAttribute("data-startup")
    )
      return;
    const token = revision;
    try {
      const [visible, minimized] = await Promise.all([
        currentWindow.isVisible(),
        currentWindow.isMinimized(),
      ]);
      if (disposed || token !== revision || active) return;
      // WebView2 does not always emit visibilitychange for system minimization.
      if (!visible || minimized) {
        if (!hidden) {
          ++revision;
          lastAction = minimized ? "minimize" : "hide";
          hidden = true;
          animate(lastAction).finish();
        }
      } else {
        void restore();
      }
    } catch (error) {
      if (token === revision && hidden) reset();
      console.error("无法同步窗口动画状态", error);
    }
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("focus", restore);
  const listeners = [
    currentWindow.listen<WindowTransition>(
      "sfmcl-t-window-transition",
      (event) => {
        void transition(event.payload);
      },
    ),
    currentWindow.onFocusChanged(() => void nativeStateChanged()),
    currentWindow.onResized(() => void nativeStateChanged()),
  ];
  for (const listener of listeners) {
    void listener.catch((error) => console.error("无法监听窗口动画", error));
  }
  return () => {
    disposed = true;
    ++revision;
    reset();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("focus", restore);
    for (const listener of listeners) {
      void listener.then((unlisten) => unlisten()).catch(console.error);
    }
  };
}
