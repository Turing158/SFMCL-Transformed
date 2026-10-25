import { invoke, isTauri } from "@tauri-apps/api/core";

export async function setStartupWindow(
  phase: "loading" | "error" | "ready" | "shown",
) {
  if (isTauri()) await invoke("startup_window", { phase });
}
