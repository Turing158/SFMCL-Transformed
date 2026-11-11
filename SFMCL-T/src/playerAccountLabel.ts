import type { Player } from "./types";

export function playerAccountLabel(player: Player): string {
  return player.yggdrasil
    ? player.yggdrasil.serverName
    : player.online
      ? "Microsoft"
      : "离线角色";
}
