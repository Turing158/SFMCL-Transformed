import { useState } from "react";

const captions = [
  "砍下了第一颗木头",
  "挖到了第一颗煤炭",
  "做出了第一把木镐",
  "用火把点亮了矿洞",
  "烧好了第一块铁锭",
  "发现了岩浆旁边的钻石",
  "给小屋装上了木门",
  "在天黑前搭好了屋顶",
  "把工作台放在了窗边",
  "在家门口种下了樱花树",
  "收获了第一颗小麦",
  "烤好了今天的牛排",
  "用一根骨头交到了朋友",
  "给小猫留了一条鱼",
  "划着小船穿过了河流",
  "在山顶看见了日出",
  "发现了一座陌生的村庄",
  "跟着火把找到回家的路",
  "在雨停之前回到了小屋",
  "给箱子塞得满满当当",
  "在地图外探险了一小段",
] as const;

export function usePlayerCaption(pageKey: string, playerName?: string) {
  const [selection, setSelection] = useState({ pageKey, index: 0 });
  let current = selection;
  if (selection.pageKey !== pageKey) {
    current = { pageKey, index: (selection.index + 1) % captions.length };
    // Update before rendering either footer, without flashing the previous line.
    setSelection(current);
  }
  return playerName ? `${playerName} ${captions[current.index]}` : "";
}
