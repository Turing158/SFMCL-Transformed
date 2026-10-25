import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../components";
import { positionTooltip, useTooltipMotion } from "../Tooltip";
import { usePageActive } from "../PageActivity";
import type { ResourceFile } from "../types";

const loaderNames: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
  liteloader: "LiteLoader",
  iris: "Iris",
  optifine: "OptiFine",
};

export function ProjectFileTags({
  resource,
  descriptionId,
  focused,
}: {
  resource: ResourceFile;
  descriptionId: string;
  focused: boolean;
}) {
  const pageActive = usePageActive();
  const tags = useMemo(
    () => [
      ...[...new Set(resource.loaders.map((loader) => loader.toLowerCase()))]
        .filter((loader) => loader !== "minecraft")
        .map((loader) => ({
          key: `loader-${loader}`,
          label: loaderNames[loader] || loader,
          loader: true,
        })),
      ...[...new Set(resource.gameVersions)].map((version) => ({
        key: `version-${version}`,
        label: version,
        loader: false,
      })),
    ],
    [resource.loaders, resource.gameVersions],
  );
  const row = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const touch = useRef(false);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  const [hovered, setHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const overflow = visibleCount < tags.length;
  const open = pageActive && overflow && (hovered || focused) && !dismissed;
  const isOpen = useRef(open);
  isOpen.current = open;
  const present = useTooltipMotion(open, popup);

  useLayoutEffect(() => {
    const anchor = row.current;
    const sizing = measure.current;
    if (!anchor || !sizing) return;
    const update = () => {
      const badges = Array.from(sizing.children) as HTMLElement[];
      const gap = parseFloat(getComputedStyle(sizing).columnGap) || 0;
      const widths = badges
        .slice(0, -1)
        .map((badge) => badge.getBoundingClientRect().width);
      const total =
        widths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, widths.length - 1) * gap;
      if (total <= anchor.clientWidth) {
        setVisibleCount(tags.length);
        return;
      }
      // Reserve the complete [+] badge before choosing the visible prefix.
      const available =
        anchor.clientWidth - badges.at(-1)!.getBoundingClientRect().width;
      let used = 0;
      let count = 0;
      for (const width of widths) {
        used += width + gap;
        if (used > available) break;
        count++;
      }
      setVisibleCount(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    observer.observe(sizing);
    return () => observer.disconnect();
  }, [tags]);

  useEffect(() => {
    if (focused) setDismissed(false);
  }, [focused]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    const anchor = row.current;
    const panel = popup.current;
    if (!present || !anchor || !panel) return;
    const position = () => {
      if (
        !positionTooltip(anchor, panel, {
          width: 400,
          preferred: "bottom",
          align: "start",
        })
      ) {
        setDismissed(true);
      }
    };
    const dismiss = (event: KeyboardEvent) => {
      if (isOpen.current && event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
      }
    };
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node)) setDismissed(true);
    };
    const otherRow = (event: PointerEvent) => {
      const target = (event.target as Element).closest(".project-file-tag-row");
      if (target && target !== anchor) setDismissed(true);
    };
    const scroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) position();
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    observer.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("pointerover", otherRow, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("pointerover", otherRow, true);
    };
  }, [present, tags]);

  const enter = () => {
    clearTimeout(closeTimer.current);
    setHovered(true);
    setDismissed(false);
  };
  const leave = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), 140);
  };
  const badge = (tag: (typeof tags)[number]) => (
    <Badge key={tag.key} className={tag.loader ? "project-file-loader" : ""}>
      {tag.label}
    </Badge>
  );

  return (
    <>
      <span id={descriptionId} className="sr-only">
        {tags.length
          ? `支持的版本：${tags.map((tag) => tag.label).join("、")}`
          : "未提供兼容版本信息"}
      </span>
      {tags.length > 0 && (
        <span
          ref={row}
          className="project-file-tag-row"
          data-overflow={overflow || undefined}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onPointerDown={(event) => {
            touch.current = event.pointerType === "touch";
          }}
          onClick={(event) => {
            if (touch.current && overflow) {
              event.stopPropagation();
              setHovered(true);
              setDismissed(false);
            }
          }}
        >
          <span className="catalog-tags project-file-tags" aria-hidden="true">
            {tags.slice(0, visibleCount).map(badge)}
            {overflow && <Badge className="project-file-more">+</Badge>}
          </span>
          <span
            ref={measure}
            className="project-file-tags project-file-tags-measure"
            aria-hidden="true"
          >
            {tags.map(badge)}
            <Badge className="project-file-more">+</Badge>
          </span>
        </span>
      )}
      {present &&
        createPortal(
          <div
            ref={popup}
            role="tooltip"
            aria-hidden={!open}
            className="project-file-tooltip sfmcl-t-tooltip"
            onPointerEnter={enter}
            onPointerLeave={leave}
            onClick={(event) => event.stopPropagation()}
          >
            <strong>支持的版本</strong>
            <div className="project-file-tooltip-tags">{tags.map(badge)}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
