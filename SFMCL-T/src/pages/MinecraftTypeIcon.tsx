import { ResourceImage } from "../components";
import { matchesVersionFilter } from "../installOptions";
import type { ManifestVersion } from "../types";

// Match the version-title sprites in Minecraft Wiki's April Fools navbox.
// 22w13oneblockatatime uses the user-selected White Carpet JE2 BE2 image.
// Keys use lowercase to accept both the manifest and Wiki's version spelling.
const aprilVersionIcons: Record<string, string> = {
  "15w14a": "15w14a.png",
  "1.rv-pre1": "1-rv-pre1.png",
  "3d shareware v1.34": "3d-shareware-v1-34.png",
  "20w14infinite": "20w14infinite.png",
  "22w13oneblockatatime": "white-carpet-je2-be2.png",
  "23w13a_or_b": "23w13a_or_b.png",
  "24w14potato": "24w14potato.png",
  "25w14craftmine": "25w14craftmine.png",
  "26w14a": "26w14a.png",
};

// April Fools versions take precedence over their snapshot/old manifest type.
export function MinecraftTypeIcon({ version }: { version: ManifestVersion }) {
  let path = "/assets/DefaultGameIcon/unknowGame.png";
  if (matchesVersionFilter(version, "april")) {
    const icon = aprilVersionIcons[version.id.toLowerCase()];
    path = icon
      ? `/assets/minecraft/april-fools/${icon}`
      : "/assets/element/diamond_pickaxe.png";
  } else if (matchesVersionFilter(version, "old")) {
    path = "/assets/element/bedrock.png";
  } else if (version.type === "release") {
    path = "/assets/DefaultGameIcon/Minecraft.png";
  } else if (version.type === "snapshot") {
    path = "/assets/DefaultGameIcon/snapshot.png";
  }
  return (
    <ResourceImage
      path={path}
      alt=""
      fallback="/assets/DefaultGameIcon/unknowGame.png"
    />
  );
}
