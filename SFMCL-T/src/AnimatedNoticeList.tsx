import { useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import type { PointerReorderOptions } from "./usePointerReorder";
import type { HomeNoticeLayout } from "./types";
import { PixelFrame } from "./components";
import { useNoticeReorder } from "./useNoticeReorder";

interface Item<T> {
  key: string;
  item: T;
}
interface Entry<T> extends Item<T> {
  phase: "stable" | "entering" | "exiting";
  revision: number;
}
const timing = {
  duration: 320,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
  fill: "both",
} as const;
type ListAttributes = HTMLAttributes<HTMLDivElement> & {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export function AnimatedNoticeList<T>({
  items,
  children,
  className = "",
  layout = "single",
  onReorder,
  rowProps,
  listProps,
  reorderOptions,
}: {
  items: Item<T>[];
  children: (item: T) => ReactNode;
  className?: string;
  layout?: HomeNoticeLayout;
  onReorder?: (keys: string[]) => void;
  rowProps?: (item: T) => ListAttributes;
  listProps?: ListAttributes;
  reorderOptions?: PointerReorderOptions;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { order, draggingKey } = useNoticeReorder(
    root,
    items.filter((entry) => entry.item !== null).map((entry) => entry.key),
    layout,
    onReorder,
    reorderOptions,
  );
  const mounted = useRef(false);
  const running = useRef(
    new Map<string, { revision: number; animations: Animation[] }>(),
  );
  const [display, setDisplay] = useState({
    source: items,
    entries: items.map((item): Entry<T> => ({
      ...item,
      phase: "stable",
      revision: 0,
    })),
  });
  let current = display;
  if (display.source !== items) {
    const before = new Map(display.entries.map((entry) => [entry.key, entry]));
    const keys = new Set(items.map((item) => item.key));
    const entries = items.map((item): Entry<T> => {
      const previous = before.get(item.key);
      return previous
        ? {
            ...previous,
            ...item,
            phase: previous.phase === "exiting" ? "entering" : previous.phase,
            revision:
              previous.revision + (previous.phase === "exiting" ? 1 : 0),
          }
        : { ...item, phase: "entering", revision: 0 };
    });
    // Keep departing rows in their previous position until their space has closed.
    display.entries.forEach((entry, index) => {
      if (keys.has(entry.key)) return;
      const anchor = display.entries
        .slice(index + 1)
        .find((next) => keys.has(next.key));
      const position = anchor
        ? entries.findIndex((next) => next.key === anchor.key)
        : entries.length;
      entries.splice(position, 0, {
        ...entry,
        phase: "exiting",
        revision: entry.revision + (entry.phase === "exiting" ? 0 : 1),
      });
    });
    current = { source: items, entries };
    setDisplay(current);
  }

  useLayoutEffect(() => {
    mounted.current = true;
    const animations = running.current;
    return () => {
      mounted.current = false;
      animations.forEach((entry) =>
        entry.animations.forEach((animation) => animation.cancel()),
      );
      animations.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const list = root.current;
    if (!list || layout !== "masonry") return;
    const rows = Array.from(list.children) as HTMLDivElement[];
    // Keep DOM and keyboard order while packing cards into four-pixel grid rows.
    // Observe the outer row so expansion, images and removal animations reflow.
    const measure = (row: HTMLDivElement) => {
      const span = String(Math.max(1, Math.ceil(row.offsetHeight / 4)));
      if (row.style.getPropertyValue("--notice-row-span") !== span)
        row.style.setProperty("--notice-row-span", span);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.target as HTMLDivElement);
    });
    rows.forEach((row) => {
      measure(row);
      observer.observe(row, { box: "border-box" });
    });
    return () => {
      observer.disconnect();
      // Keep spans until the next measurement. Clearing them temporarily
      // collapses the grid and clamps a scrolled page before it grows again.
    };
  }, [current.entries, layout]);

  useLayoutEffect(() => {
    const list = root.current;
    if (!list) return;
    const entries = current.entries;
    const nodes = new Map(
      Array.from(list.children, (node) => [
        node.getAttribute("data-notice-key"),
        node as HTMLDivElement,
      ]),
    );
    const finish = (key: string, revision: number) => {
      if (!mounted.current) return;
      setDisplay((latest) => {
        const entry = latest.entries.find((entry) => entry.key === key);
        if (!entry || entry.revision !== revision || entry.phase === "stable")
          return latest;
        return {
          ...latest,
          entries:
            entry.phase === "exiting"
              ? latest.entries.filter((entry) => entry.key !== key)
              : latest.entries.map((entry) =>
                  entry.key === key
                    ? { ...entry, phase: "stable" as const }
                    : entry,
                ),
        };
      });
    };
    running.current.forEach((active, key) => {
      const entry = entries.find((entry) => entry.key === key);
      if (!entry || entry.phase === "stable") {
        active.animations.forEach((animation) => animation.cancel());
        running.current.delete(key);
      }
    });
    for (const entry of entries) {
      if (entry.phase === "stable") continue;
      const row = nodes.get(entry.key);
      const content = row?.firstElementChild as HTMLDivElement | null;
      if (!row || !content) continue;
      if (
        !list.getClientRects().length ||
        document.documentElement.hasAttribute("data-startup")
      ) {
        finish(entry.key, entry.revision);
        continue;
      }
      const previous = running.current.get(entry.key);
      if (previous?.revision === entry.revision) continue;
      // A reversed move starts from the visible frame instead of restarting at zero.
      const before = getComputedStyle(row);
      const height = parseFloat(before.height);
      const gap = before.paddingBottom;
      const visual = getComputedStyle(content);
      const opacity = visual.opacity;
      const transform = visual.transform;
      previous?.animations.forEach((animation) => animation.cancel());
      const targetHeight = row.offsetHeight;
      const targetGap = getComputedStyle(row).paddingBottom;
      const leaving = entry.phase === "exiting";
      const animations = [
        row.animate(
          [
            {
              height: `${previous || leaving ? height : 0}px`,
              paddingBottom: previous || leaving ? gap : "0px",
            },
            {
              height: `${leaving ? 0 : targetHeight}px`,
              paddingBottom: leaving ? "0px" : targetGap,
            },
          ],
          { ...timing, id: "sfmcl-t-notice-list-height" },
        ),
        content.animate(
          [
            {
              opacity: previous ? opacity : leaving ? 1 : 0,
              transform: previous
                ? transform
                : leaving
                  ? "translate(0, 0) scale(1)"
                  : "translateY(10px) scale(0.985)",
            },
            {
              opacity: leaving ? 0 : 1,
              transform: leaving
                ? "translateX(18px) scale(0.98)"
                : "translate(0, 0) scale(1)",
            },
          ],
          {
            ...timing,
            id: `sfmcl-t-notice-list-${leaving ? "exit" : "enter"}`,
          },
        ),
      ];
      const active = { revision: entry.revision, animations };
      running.current.set(entry.key, active);
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        if (running.current.get(entry.key) === active)
          finish(entry.key, entry.revision);
      });
    }
  }, [current.entries]);

  const entries = order
    ? [...current.entries].sort((a, b) => {
        const rank = (key: string) => {
          const index = order.indexOf(key);
          return index < 0 ? order.length : index;
        };
        return rank(a.key) - rank(b.key);
      })
    : current.entries;

  return (
    <div
      {...listProps}
      ref={root}
      className={`notice-animated-list ${className}`}
      data-notice-layout={layout}
      data-notice-sortable={!!onReorder}
      data-notice-list-moving={current.entries.some(
        (entry) => entry.phase !== "stable",
      )}
    >
      {entries.map((entry) => (
        <div
          {...rowProps?.(entry.item)}
          key={entry.key}
          className={`notice-list-item ${rowProps?.(entry.item).className || ""}`.trim()}
          data-window-drag="false"
          data-notice-key={entry.key}
          data-notice-phase={entry.phase}
          data-notice-placeholder={entry.key === draggingKey || undefined}
          aria-hidden={entry.phase === "exiting" ? true : undefined}
          inert={entry.phase === "exiting"}
        >
          <div
            className="notice-list-content"
            inert={entry.key === draggingKey}
          >
            {children(entry.item)}
          </div>
          {entry.key === draggingKey && (
            <div
              className="notice-drag-placeholder has-surface"
              aria-hidden="true"
            >
              <PixelFrame />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
