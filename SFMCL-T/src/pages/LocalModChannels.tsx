import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { PixelFrame } from "../components";
import { api } from "../api";
import { useApp } from "../store";
import { resourceSourceNames, type ResourceSource } from "../resourceSources";
import type { LocalResource, Project, Version } from "../types";

export function LocalModChannels({
  item,
  version,
  onOpen,
}: {
  item: LocalResource;
  version: Version;
  onOpen: (project: Project, trigger: HTMLButtonElement) => void;
}) {
  const app = useApp();
  const active = useRef(true);
  const matches = useRef(new Map<ResourceSource, { id: string }>());
  const [pending, setPending] = useState<ResourceSource | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const open = (source: ResourceSource, trigger: HTMLButtonElement) => {
    setPending(source);
    void app.run(async () => {
      try {
        const match =
          matches.current.get(source) ??
          (await api<{ id: string } | null>("resources.localProject", {
            source,
            path: item.path,
            versionId: version.id,
            directory: version.directory,
          }));
        if (!active.current) return;
        if (!match)
          throw new Error(
            `未找到此模组文件对应的 ${resourceSourceNames[source]} 项目`,
          );
        matches.current.set(source, match);
        onOpen(
          {
            id: match.id,
            source,
            title: item.name,
            description: item.description,
            author: item.authors,
            icon: item.icon,
            downloads: 0,
            categories: [],
            versions: [version.version],
            website: "",
            body: "",
          },
          trigger,
        );
      } finally {
        if (active.current) setPending(null);
      }
    });
  };
  return (
    <div
      className="local-mod-channels has-surface"
      role="group"
      aria-label={`${item.name} 的模组详情渠道`}
    >
      <PixelFrame />
      <div className="local-mod-channel-buttons">
        {(["modrinth", "curseforge"] as const).map((source) => (
          <button
            key={source}
            type="button"
            className="local-mod-channel resource-source"
            data-source={source}
            aria-label={`${item.name} 的 ${resourceSourceNames[source]} 详情`}
            aria-busy={pending === source}
            disabled={app.busy || !!pending}
            onClick={(event) => open(source, event.currentTarget)}
          >
            <span>{resourceSourceNames[source]}</span>
            {pending === source && (
              <LoaderCircle
                className="local-mod-channel-loading"
                size={10}
                aria-hidden="true"
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
