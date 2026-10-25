import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  loaderKinds,
  optifineForgeVersion,
  type InstallComponent,
} from "../installOptions";
import type { Loader, ResourceFile } from "../types";

export interface InstallChoice {
  value: string;
  description: string;
  loader?: Loader;
  file?: ResourceFile;
}
interface Catalog {
  choices: InstallChoice[];
  loading: boolean;
  error: string;
}
const components: InstallComponent[] = [...loaderKinds, "FabricAPI"];
const initialCatalogs = (): Record<InstallComponent, Catalog> => {
  const empty = (): Catalog => ({ choices: [], loading: true, error: "" });
  return {
    Forge: empty(),
    OptiFine: empty(),
    Fabric: empty(),
    FabricAPI: empty(),
    NeoForge: empty(),
    Quilt: empty(),
    LiteLoader: empty(),
  };
};

export function useInstallCatalog(minecraft: string) {
  const [catalogs, setCatalogs] = useState(initialCatalogs);
  const generation = useRef(0);
  const requests = useRef<Partial<Record<InstallComponent, number>>>({});
  const load = useCallback(
    async (kind: InstallComponent, current: number) => {
      const request = (requests.current[kind] ?? 0) + 1;
      requests.current[kind] = request;
      const active = () =>
        generation.current === current && requests.current[kind] === request;
      setCatalogs((previous) => ({
        ...previous,
        [kind]: { ...previous[kind], loading: true, error: "" },
      }));
      try {
        let choices: InstallChoice[];
        if (kind === "FabricAPI") {
          const files = await api<ResourceFile[]>("resources.files", {
            source: "modrinth",
            id: "P7dR8mSH",
            gameVersion: minecraft,
            loader: "fabric",
          });
          choices = files
            .filter(
              (file) =>
                file.file &&
                file.gameVersions.includes(minecraft) &&
                file.loaders.includes("fabric"),
            )
            .map((file) => ({
              value: file.id,
              file,
              description: file.date.slice(0, 10),
            }));
        } else {
          const loaders = await api<Loader[]>("loaders", { minecraft, kind });
          choices = loaders
            .filter((loader) => loader.kind === kind)
            .map((loader) => ({
              value: loader.version,
              loader,
              description:
                kind === "OptiFine"
                  ? optifineForgeVersion(loader)
                    ? `兼容 Forge ${optifineForgeVersion(loader)}`
                    : "独立安装 · 未标注兼容的 Forge"
                  : /pre|beta|alpha|snapshot/i.test(loader.version)
                    ? "测试版"
                    : "",
            }));
        }
        if (active())
          setCatalogs((previous) => ({
            ...previous,
            [kind]: { choices, loading: false, error: "" },
          }));
      } catch (error) {
        if (active())
          setCatalogs((previous) => ({
            ...previous,
            [kind]: { choices: [], loading: false, error: String(error) },
          }));
      }
    },
    [minecraft],
  );

  useEffect(() => {
    const current = ++generation.current;
    setCatalogs(initialCatalogs());
    for (const kind of components) void load(kind, current);
    return () => {
      generation.current++;
    };
  }, [load]);

  return {
    catalogs,
    retry: (kind: InstallComponent) => void load(kind, generation.current),
  };
}
