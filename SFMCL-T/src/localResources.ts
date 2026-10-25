import { api, bytes } from "./api";
import type { LocalResource } from "./types";

export function isLocalResourceDirectory(item: LocalResource): boolean {
  return (
    item.kind === "world" ||
    item.entryType === "resourceDirectory" ||
    item.entryType === "directory"
  );
}

export function openLocalResource(item: LocalResource): Promise<unknown> {
  return api("path.open", {
    path: item.path,
    ...(!isLocalResourceDirectory(item) ? { reveal: true } : {}),
  });
}

export function localResourceSize(item: {
  size: number | null;
  sizePending?: boolean;
}): string {
  if (item.sizePending) return "计算中…";
  return item.size === null ? "大小未知" : bytes(item.size);
}
