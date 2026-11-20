import type { Settings } from "./types";

export const backgroundDefaults = {
  backgroundOverlayOpacity: 65,
  backgroundBlur: 0,
} as const satisfies Pick<
  Settings,
  "backgroundOverlayOpacity" | "backgroundBlur"
>;

export function backgroundSource(settings: Settings, defaultPath = "") {
  return settings.backgroundType === "default"
    ? defaultPath
    : ["local", "remote"].includes(settings.backgroundType)
      ? settings.background
      : "";
}
