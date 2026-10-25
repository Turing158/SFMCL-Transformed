import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { failStartup, initializeStartupScreen } from "./startupScreen";
import { setStartupWindow } from "./startupWindow";
import { migrateLegacyPreferences } from "./legacyPreferences";

try {
  migrateLegacyPreferences(localStorage);
} catch {
  // Browser policies can disable storage; startup remains usable in that case.
}

// Register before loading React so startup failures and portaled UI are covered.
const preventContextMenu = (event: MouseEvent) => event.preventDefault();
document.addEventListener("contextmenu", preventContextMenu, true);
if (import.meta.hot) {
  import.meta.hot.dispose(() =>
    document.removeEventListener("contextmenu", preventContextMenu, true),
  );
}

declare global {
  interface Window {
    __SFMCL_T_APPEARANCE__?: { theme: string; accent: string };
  }
}

const appearance = window.__SFMCL_T_APPEARANCE__;
if (appearance) {
  document.documentElement.dataset.theme =
    appearance.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : appearance.theme;
  document.documentElement.dataset.accent = appearance.accent;
}
initializeStartupScreen();

if (isTauri()) {
  const close = document.getElementById("startup-close")!;
  close.addEventListener("click", () => {
    void getCurrentWindow().close().catch(failStartup);
  });
}

// Give the small startup screen its own first paint before importing React and
// the application/CSS. The splash never waits for the main module graph.
void setStartupWindow("loading")
  .then(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void import("./main").catch(failStartup);
      }),
    );
  })
  .catch(failStartup);
