import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { gameDirectoryName } from "./gameDirectories";
import { invalidateImages } from "./images";
import type { Settings, Version } from "./types";

export function useAllVersions(
  enabled: boolean,
  directories: Settings["gameDirs"],
  catalogRevision: number,
) {
  const [revision, setRevision] = useState(0);
  const request = useMemo(
    () => ({ directories, catalogRevision, revision }),
    [directories, catalogRevision, revision],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    versions: Version[];
    errors: string[];
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.allSettled(
      request.directories.map(({ path }) =>
        api<Version[]>("versions.list", { directory: path }),
      ),
    ).then((responses) => {
      if (!active) return;
      const versions = new Map<string, Version>();
      const errors: string[] = [];
      responses.forEach((response, index) => {
        const directory = request.directories[index];
        if (response.status === "rejected") {
          errors.push(
            `${gameDirectoryName(directory)}（${directory.path}）：${String(response.reason)}`,
          );
          return;
        }
        for (const version of response.value) {
          // Parent-folder and legacy .minecraft entries may point to the same version.
          const path = version.path.replace(/\\/g, "/");
          const key =
            /^[a-z]:\//i.test(path) || path.startsWith("//")
              ? path.toLowerCase()
              : path;
          if (!versions.has(key))
            versions.set(key, { ...version, directory: directory.path });
        }
      });
      setResult({ request, versions: [...versions.values()], errors });
      invalidateImages();
    });
    return () => {
      active = false;
    };
  }, [enabled, request]);

  const ready = result?.request === request;
  return {
    versions: ready ? result.versions : [],
    errors: ready ? result.errors : [],
    loading: enabled && !ready,
    refresh: () => setRevision((value) => value + 1),
  };
}
