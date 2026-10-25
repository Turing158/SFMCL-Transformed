export interface ModpackInspection {
  token: string;
  format: string;
  name: string;
  version: string;
  minecraft: string;
  loader: { kind: string; version: string } | null;
  optionalFiles: string[];
  fileCount: number;
}
export interface ModpackSource {
  path: string;
  inspection: ModpackInspection;
}

export function modpackName(name: string, version = "") {
  const value = `${name} ${version}`
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 120)
    .replace(/[ .]+$/, "");
  return !value || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value)
    ? "整合包"
    : value;
}
export function modpackNameError(name: string) {
  if (
    !name.trim() ||
    name.length > 150 ||
    /[<>:"/\\|?*\u0000-\u001f]|[ .]$/.test(name) ||
    name === "." ||
    name === ".."
  )
    return "请输入有效的游戏名称。";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name))
    return "游戏名称不能使用系统保留名称。";
  return "";
}
