import { api, confirmAction, pick } from "./api";
import { useApp } from "./store";
import type { Version } from "./types";

export function versionPayload(
  version: Version,
  payload: Record<string, unknown> = {},
) {
  return {
    id: version.id,
    ...(version.directory ? { directory: version.directory } : {}),
    ...payload,
  };
}

// Shared by the version-management dialog and favorite context menu.
export function useVersionActions(
  version: Version | null,
  onClose: () => void,
) {
  const app = useApp();
  const rename = (name: string) =>
    version &&
    app.run(async () => {
      await api("versions.rename", versionPayload(version, { name }));
      await app.refresh();
      onClose();
    }, "版本已重命名");
  const openFolder = (native = false) =>
    version &&
    app.run(() =>
      api("path.open", {
        path: native ? `${version.path}/natives` : version.path,
      }),
    );
  const changeIcon = (reset = false) =>
    version &&
    app.run(async () => {
      const path = reset ? null : await pick(false, ["png"]);
      if (reset || path) {
        await app.update("versions.icon", versionPayload(version, { path }));
        onClose();
      }
    });
  const repair = () =>
    version &&
    app.run(async () => {
      await api("versions.repair", versionPayload(version));
      onClose();
      app.setPage("downloads");
    });
  const remove = async () => {
    if (!version || app.busy) return;
    if (
      await confirmAction(
        `删除版本 ${version.id} 及其版本目录？开启隔离时，此目录可能包含存档与模组，请先备份。`,
      )
    )
      await app.run(async () => {
        await api("versions.delete", versionPayload(version));
        await app.refresh();
        onClose();
      }, "版本已删除");
  };
  return { rename, openFolder, changeIcon, repair, remove };
}
