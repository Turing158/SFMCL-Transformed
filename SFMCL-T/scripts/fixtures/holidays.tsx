import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { pixelAppFixture } from "./pixel-app.mjs";
import "../../src/styles.css";
import "../../src/pixel-geometry.css";
import "../../src/controls.css";
import "../../src/surfaces.css";
import "../../src/sidebar.css";
import "../../src/resources.css";
import "../../src/players.css";
import "../../src/tooltip.css";
import "../../src/window-motion.css";
import "../../src/scrollbars.css";

// This separate test fixture changes only an injected date and in-memory data.
// The production entry point always uses the real device date.
pixelAppFixture();
window.__pixelTest.data.settings.downloadTaskDisplay = "always";
window.__pixelTest.versions.forEach((version) => {
  version.favorite = true;
});
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const native = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = async (command, args) => {
  if (command.startsWith("plugin:window|")) {
    if (command.endsWith("inner_size"))
      return { width: innerWidth, height: innerHeight };
    if (command.endsWith("scale_factor")) return 1;
    if (/is_(focused|visible)/.test(command)) return true;
    if (/is_/.test(command)) return false;
    return undefined;
  }
  return native(command, args);
};
const [
  { default: App },
  { Provider },
  { HolidayProvider },
  { OnboardingProvider },
  { TooltipHost },
  { ConfirmationDialogHost },
] = await Promise.all([
  import("../../src/App"),
  import("../../src/store"),
  import("../../src/holidays/HolidayProvider"),
  import("../../src/Onboarding"),
  import("../../src/Tooltip"),
  import("../../src/ConfirmationDialog"),
]);

function Fixture() {
  const [date, setDate] = useState("2026-11-22");
  const [year, month, day] = date.split("-").map(Number);
  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 4,
          left: "45%",
          zIndex: 200000,
          padding: "4px 8px",
          background: "var(--panel)",
        }}
      >
        <label>
          验证日期{" "}
          <input
            aria-label="验证日期"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <select
          aria-label="选择验证节日"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        >
          <option value="2026-11-22">普通日期</option>
          <option value="2026-02-17">春节</option>
          <option value="2026-06-19">端午</option>
          <option value="2026-09-25">中秋</option>
          <option value="2026-10-31">万圣节</option>
          <option value="2026-12-25">圣诞节</option>
          <option value="2026-04-01">愚人节</option>
        </select>
      </div>
      <Provider>
        <HolidayProvider date={new Date(year, month - 1, day, 12)}>
          <OnboardingProvider>
            <App />
          </OnboardingProvider>
        </HolidayProvider>
        <TooltipHost />
        <ConfirmationDialogHost />
      </Provider>
    </>
  );
}
const fixtureRoot = createRoot(document.getElementById("root")!);
fixtureRoot.render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
if (import.meta.hot) import.meta.hot.dispose(() => fixtureRoot.unmount());
