import "../src/styles.css";
import "../src/pixel-geometry.css";
import "../src/controls.css";
import "../src/surfaces.css";
import "../src/sidebar.css";
import "../src/resources.css";
import "../src/players.css";
import "../src/tooltip.css";
import "../src/window-motion.css";
import "../src/scrollbars.css";
import { pixelAppFixture } from "./fixtures/pixel-app.mjs";
import visual from "virtual:holiday-profile";
pixelAppFixture();
const fixture = window.__pixelTest;
Object.assign(fixture.data.settings, visual.settings, { onboardingVersion: 1 });
fixture.data.players = visual.players.length ? visual.players : fixture.data.players;
fixture.versions.splice(0, fixture.versions.length, ...visual.versions);
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
let home = structuredClone(visual.home);
const native = window.__TAURI_INTERNALS__.invoke;
const imagePaths = [...new Set(visual.players.flatMap(player => [player.skin, player.cape]).filter(Boolean))];
if (["local", "remote"].includes(visual.settings.backgroundType) && visual.settings.background) imagePaths.push(visual.settings.background);
window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
  if (command.startsWith("plugin:window|")) {
    if (command.endsWith("inner_size")) return { width: innerWidth, height: innerHeight };
    if (command.endsWith("scale_factor")) return 1;
    if (/is_(focused|visible)/.test(command)) return true;
    if (/is_/.test(command)) return false;
    return undefined;
  }
  if (command === "plugin:opener|open_url") return undefined;
  if (command === "request") {
    if (args.operation === "home.content.get") return structuredClone(home);
    if (args.operation === "home.content.save") { home = structuredClone(args.payload); return home; }
    if (args.operation === "notices.list") return structuredClone(visual.notices.filter(item => !visual.hidden.includes(item.id)));
    if (args.operation === "notices.refresh") return { items: structuredClone(visual.notices), error: "" };
    if (args.operation === "image") {
      const index = imagePaths.indexOf(args.payload?.path);
      return index < 0 ? "" : (await fetch(`/__holiday-image?index=${index}`)).text();
    }
  }
  return native(command, args);
};
const [React, ReactDOM, app, store, onboarding, confirmation, tooltip, scrollbars] = await Promise.all([
  import("react"), import("react-dom/client"), import("../src/App.tsx"), import("../src/store.tsx"), import("../src/Onboarding.tsx"), import("../src/ConfirmationDialog.tsx"), import("../src/Tooltip.tsx"), import("../src/scrollbars.ts"),
]);
const h = React.createElement;
function HolidayNotificationBridge() {
  const { notify } = store.useApp();
  React.useEffect(() => {
    const onNotify = event => notify(event.detail);
    window.addEventListener("sfmcl:holiday-notify", onNotify);
    return () => window.removeEventListener("sfmcl:holiday-notify", onNotify);
  }, [notify]);
  return null;
}
ReactDOM.createRoot(document.getElementById("root")).render(h(React.StrictMode, null, h(store.Provider, null, h(HolidayNotificationBridge), h(onboarding.OnboardingProvider, null, h(app.default)), h(confirmation.ConfirmationDialogHost), h(tooltip.TooltipHost))));
scrollbars.initializeScrollbars();
await import("./holiday-overlays.mjs");
