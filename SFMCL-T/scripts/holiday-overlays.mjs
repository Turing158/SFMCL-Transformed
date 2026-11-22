import { mountHolidayOverlay } from "../src/holidays/overlays.mjs";

// Preview-only controls; the launcher never accepts these window messages.
let overlay;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== location.origin) return;
  const request = event.data;
  if (
    request?.type !== "sfmcl:holiday" ||
    !["spring", "dragon", "moon", "spooky", "winter", "fools"].includes(
      request.season,
    )
  )
    return;
  const config = {
    ...request,
    defs: `<svg width="0" height="0" xmlns="http://www.w3.org/2000/svg">${request.defs}</svg>`,
  };
  if (overlay) overlay.update(config);
  else
    overlay = mountHolidayOverlay(config, {
      manageGreeting: true,
      notify: (message) =>
        window.dispatchEvent(
          new CustomEvent("sfmcl:holiday-notify", { detail: message }),
        ),
      onUnlock: () =>
        parent.postMessage({ type: "sfmcl:prank-unlocked" }, location.origin),
      onSurrender: () =>
        parent.postMessage(
          { type: "sfmcl:prank", surrendered: true },
          location.origin,
        ),
      onCapabilities: (value) =>
        parent.postMessage(
          { type: "sfmcl:capabilities", ...value },
          location.origin,
        ),
    });
});
document.addEventListener(
  "click",
  (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest(".launch-primary")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage(
        { type: "sfmcl:toast", text: "开始游戏按钮已响应" },
        location.origin,
      );
    }
  },
  true,
);
if (import.meta.hot) import.meta.hot.dispose(() => overlay?.dispose());
parent.postMessage({ type: "sfmcl:ready" }, location.origin);
