import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beginStartupWork } from "./startupReadiness";
export { confirmAction } from "./confirmation";
export const desktop = isTauri();
export async function api<T = unknown>(
  operation: string,
  payload: unknown = {},
): Promise<T> {
  if (!desktop)
    throw new Error(
      "此操作需要在 SFMCL-T 桌面应用中运行。请使用 npm run desktop 启动。",
    );
  const done = beginStartupWork();
  try {
    return await invoke<T>("request", { operation, payload });
  } finally {
    done();
  }
}
export async function pick(
  directory = false,
  extensions?: string[],
  labels?: { title?: string; filterName?: string },
): Promise<string | null> {
  if (!desktop) throw new Error("文件选择器需要桌面环境");
  const result = await open({
    title: labels?.title,
    directory,
    multiple: false,
    filters: extensions
      ? [{ name: labels?.filterName || "文件", extensions }]
      : undefined,
  });
  return typeof result === "string" ? result : null;
}
export async function pickJava(): Promise<string | null> {
  const path = await pick(false, ["exe"], {
    title: "选择 java.exe 或 javaw.exe",
    filterName: "Java 运行环境（java.exe 或 javaw.exe）",
  });
  if (path && !/(?:^|[\\/])javaw?\.exe$/i.test(path)) {
    throw new Error(
      "只能选择 java.exe 或 javaw.exe，请在 Java 安装目录的 bin 文件夹中选择。",
    );
  }
  return path;
}
export async function external(url: string) {
  if (!/^https?:\/\//.test(url)) throw new Error("无效网页地址");
  if (desktop) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < 3);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
export const statusLabel = {
  queued: "等待中",
  running: "进行中",
  pausing: "正在暂停",
  paused: "已暂停",
  completed: "已完成",
  failed: "需要处理",
  cancelled: "已取消",
};
