import type { DownloadSpec } from "./types";
export interface PackOrigin {
  source: string;
  projectId: string;
  versionId: string;
}
export interface PackRecord {
  instanceId: string;
  name: string;
  version: string;
  minecraft: string;
  loader: { kind: string; version: string } | null;
  origin: PackOrigin | null;
  includeOptional: boolean;
}
export interface PackRelease {
  id: string;
  name: string;
  version: string;
  date: string;
  gameVersions: string[];
  loaders: string[];
  stable: boolean;
  file: DownloadSpec;
}
export interface UpdateInfo {
  record: PackRecord | null;
  current: { name?: string; version?: string } | null;
  backups: { id: string; state: string; path: string; savesBackup: boolean }[];
}
export interface UpdateDiscovery {
  status: "online" | "local" | "upToDate";
  message: string;
  currentOrigin: PackOrigin | null;
  targetOrigin: PackOrigin | null;
  current: PackRelease | null;
  target: PackRelease | null;
  includeOptional: boolean;
  inferOptional: boolean;
}
export interface UpdateItem {
  path: string;
  localPath: string;
  destinationPath: string;
  action: string;
  conflict: boolean;
  reason: string;
}
export interface UpdatePlan {
  token: string;
  current: { name: string; version: string; minecraft: string; loader: string };
  target: PackRecord;
  items: UpdateItem[];
  baselineMissing: boolean;
  warnings: string[];
}
export function unresolvedConflicts(
  plan: UpdatePlan,
  decisions: Record<string, string>,
) {
  return plan.items.filter(
    (item) =>
      item.conflict &&
      !["keep", "replace"].includes(decisions[item.path] ?? ""),
  ).length;
}
export function recommendedRelease(releases: PackRelease[], current = "") {
  const currentIndex = releases.findIndex((release) => release.id === current);
  const newer = currentIndex < 0 ? releases : releases.slice(0, currentIndex);
  return newer.find((release) => release.stable) ?? newer[0];
}
export const updateActions: Record<string, string> = {
  add: "新增",
  replace: "替换",
  remove: "删除",
  keep: "保留",
  conflict: "待处理",
};
