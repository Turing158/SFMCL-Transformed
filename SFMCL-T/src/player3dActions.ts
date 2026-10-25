export const player3dActions = ["still", "walk", "run", "fly", "wave"] as const;
export type Player3DAction = (typeof player3dActions)[number];

export const player3dActionLabel: Record<Player3DAction, string> = {
  still: "静止",
  walk: "行走",
  run: "奔跑",
  fly: "飞行",
  wave: "挥手",
};

export const nextPlayer3DAction = (action: Player3DAction): Player3DAction =>
  player3dActions[
    (player3dActions.indexOf(action) + 1) % player3dActions.length
  ];
