import { StartupAnimation } from "./startupAnimation";
import { closeStartupWork, waitForStartupPaint } from "./startupReadiness";
import { isTauri } from "@tauri-apps/api/core";
import { setStartupWindow } from "./startupWindow";
import { startupTimeout } from "./startupTimeout";

let animation: StartupAnimation | undefined;
let revealing = false;
let failed = false;
let cancelTimeout = () => {};
const failure = new AbortController();

export function initializeStartupScreen() {
  const element = document.getElementById("startup-screen")!;
  animation = new StartupAnimation(element);
  cancelTimeout = startupTimeout(
    () => failStartup(new Error("准备界面超时，请重试启动。")),
    30_000,
  );
  document
    .getElementById("startup-retry")!
    .addEventListener("click", () => location.reload());
  // The original icon is already in the document, so no React code is needed.
  void Promise.all(
    [...element.querySelectorAll("img")].map((image) =>
      image.decode().catch(() => {}),
    ),
  ).then(() => animation?.start());
}

export function failStartup(error: unknown) {
  if (revealing || failed) return;
  failed = true;
  failure.abort(error);
  cancelTimeout();
  const message = error instanceof Error ? error.message : String(error);
  document.getElementById("startup-error")!.hidden = false;
  document.getElementById("startup-error-message")!.textContent =
    `启动未完成：${message}`;
  document.getElementById("startup-status")!.textContent =
    "启动未完成，可以重试。";
  document.getElementById("startup-screen")!.dataset.state = "error";
  document.getElementById("startup-close")!.hidden = !isTauri();
  document.getElementById("startup-retry")!.focus();
  void setStartupWindow("error").catch(console.error);
  void animation?.finish();
}

export async function revealStartup(root: HTMLElement, signal: AbortSignal) {
  if (revealing || failed) return;
  signal = AbortSignal.any([signal, failure.signal]);
  await waitForStartupPaint(root, signal);
  await animation?.finish();
  signal.throwIfAborted();
  await setStartupWindow("ready");
  signal.throwIfAborted();
  // State or an image can change while the last word is being written.
  await waitForStartupPaint(root, signal);
  signal.throwIfAborted();
  if (revealing || failed) return;
  revealing = true;
  cancelTimeout();
  closeStartupWork();
  document.documentElement.dataset.startup = "revealing";
  const splash = document.getElementById("startup-screen")!;
  const enter = root.animate(
    [
      { transform: "scale(0.8)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    {
      id: "sfmcl-t-startup-reveal",
      duration: 380,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "both",
    },
  );
  const exit = splash.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 160,
    easing: "ease-out",
    fill: "both",
  });
  await Promise.allSettled([enter.finished, exit.finished]);
  // Remove the transform so fixed menus/dialogs keep their usual containing block.
  delete document.documentElement.dataset.startup;
  root.inert = false;
  root.removeAttribute("aria-hidden");
  root.removeAttribute("aria-busy");
  enter.cancel();
  exit.cancel();
  animation?.dispose();
  splash.remove();
  // Native shadows also restore Windows 11 corners. Wait until the transparent
  // reveal finishes so the full window frame does not appear behind the splash.
  await setStartupWindow("shown").catch(console.error);
}
