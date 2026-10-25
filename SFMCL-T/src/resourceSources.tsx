import { Badge } from "./components";

export const resourceSourceNames = {
  modrinth: "Modrinth",
  curseforge: "CurseForge",
} as const;
export type ResourceSource = keyof typeof resourceSourceNames;

export function ResourceSourceBadge({ source }: { source: string }) {
  return (
    <Badge
      className="resource-source resource-source-badge"
      data-source={source}
      aria-label={`资源渠道：${resourceSourceNames[source as ResourceSource] ?? source}`}
    >
      {resourceSourceNames[source as ResourceSource] ?? source}
    </Badge>
  );
}
