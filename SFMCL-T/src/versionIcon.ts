import type { Version } from "./types";

export function versionIcon(version?: Version) {
  if (!version) return "";
  const names: Record<string, string> = {
    Vanilla: "Minecraft",
    Quilt: "quiltmc",
    OptiFine: "Optifine",
  };
  return (
    version.icon ||
    `/assets/DefaultGameIcon/${names[version.loader] || version.loader}.png`
  );
}
