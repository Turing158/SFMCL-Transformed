import type { ManifestVersion } from "../types";

// Match StarFallMC's MinecraftDownloaderTypeToLabelConverter and iconfont.ttf.
// April Fools releases retain their manifest type, just as they do in StarFall.
export function MinecraftTypeIcon({ version }: { version: ManifestVersion }) {
  const glyph = version.type.startsWith("old_")
    ? "O"
    : version.type === "release"
      ? "R"
      : version.type === "snapshot"
        ? "S"
        : "N";
  return (
    <span className="resource-icon minecraft-type-icon" aria-hidden="true">
      {glyph}
    </span>
  );
}
