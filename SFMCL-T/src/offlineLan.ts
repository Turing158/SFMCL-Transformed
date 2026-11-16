import type { Project } from "./types";

export function offlineLanModLoader(loader: string) {
  return !["", "vanilla", "optifine"].includes(loader.toLowerCase());
}

export function offlineLanVersionDetails(version: {
  id?: string;
  inheritsFrom?: string;
  clientVersion?: string;
  libraries?: unknown;
}) {
  const libraries = JSON.stringify(version.libraries ?? []).toLowerCase();
  const loader =
    [
      ["neoforged", "NeoForge"],
      ["minecraftforge", "Forge"],
      ["quiltmc", "Quilt"],
      ["fabricmc", "Fabric"],
      ["optifine", "OptiFine"],
      ["liteloader", "LiteLoader"],
    ].find(([name]) => libraries.includes(name))?.[1] ?? "Vanilla";
  return {
    loader,
    version: version.inheritsFrom ?? version.clientVersion ?? version.id ?? "",
  };
}

export const offlineLanProject: Project = {
  id: "RTWpcTBp",
  source: "modrinth",
  title: "LAN World Plug-n-Play",
  description: "自定义对局域网开放设置，允许离线角色加入房主的世界。",
  author: "Satxm",
  icon: "",
  downloads: 0,
  categories: [],
  versions: [],
  website: "https://modrinth.com/mod/mcwifipnp",
  body: "",
};
