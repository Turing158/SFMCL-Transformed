import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Box, Download, Globe, Layers, Package, Sun } from "lucide-react";
import { PixelFrame } from "../components";
import { PageTitle } from "../PageHeader";
import type { ResourceTab } from "../navigation";

export function ResourceSubpage({
  title,
  tab,
  children,
}: {
  title: string;
  tab: ResourceTab | "world";
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const Icon = {
    minecraft: Download,
    mod: Box,
    shader: Sun,
    resourcepack: Layers,
    datapack: Package,
    modpack: Package,
    world: Globe,
  }[tab];
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="resource-subpage" aria-label={title}>
      <header className="resource-subpage-header">
        <PageTitle
          icon={<Icon />}
          title={title}
          eyebrow={
            tab === "minecraft" ? "MINECRAFT INSTALLATION" : "RESOURCE DETAILS"
          }
          headingRef={heading}
        />
      </header>
      <div
        className={`resource-subpage-body has-surface ${tab === "minecraft" ? "minecraft-config" : ""}`}
      >
        <PixelFrame />
        {children}
      </div>
    </section>
  );
}
