import type { Bootstrap, Player } from "./types";

export function mutationImagePaths(
  operation: string,
  payload: unknown,
  result: unknown,
  data: Bootstrap,
): string[] {
  const args = payload as { id?: string; directory?: string } | null;
  if (["players.skin", "players.cape", "players.refresh"].includes(operation)) {
    const old = data.players.find((player) => player.uuid === args?.id);
    const next = result as Partial<Player> | null;
    return [old?.skin, old?.cape, next?.skin, next?.cape].filter(
      (path): path is string => !!path,
    );
  }
  if (operation === "versions.icon" && args?.id) {
    const directory = (args.directory ?? data.settings.activeDir).replace(
      /[\\/]+$/,
      "",
    );
    const root = /(?:^|[\\/])\.minecraft$/i.test(directory)
      ? directory
      : `${directory}/.minecraft`;
    return [`${root}/versions/${args.id}/icon.png`];
  }
  return [];
}
