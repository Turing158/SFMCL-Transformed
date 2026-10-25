import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Box, Download, Globe, Layers, Package, Sun, X } from "lucide-react";
import { Button, PixelFrame } from "../components";
import { PageTitle } from "../PageHeader";
import { useApp } from "../store";
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
  const app = useApp();
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
        {app.error && (
          <div className="inline-error resource-error" role="alert">
            {app.error}
            <Button aria-label="关闭错误提示" onClick={app.clearError}>
              <X size={16} />
            </Button>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
