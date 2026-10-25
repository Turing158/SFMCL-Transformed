import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PixelFrame } from "../components";
import type { ResourceView } from "./CatalogView";

const easing = "cubic-bezier(0.22, 0.8, 0.25, 1)";

export function CatalogItems({
  view,
  revision,
  label,
  id,
  className = "",
  children,
}: {
  view: ResourceView;
  revision?: unknown;
  label?: string;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element?.getClientRects().length) return;
    const animations: Animation[] = [];
    Array.from(element.children).forEach((item, index) => {
      const delay = Math.min(index, 5) * 28;
      animations.push(
        item.animate(
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          {
            id: "sfmcl-t-catalog-item",
            duration: 240,
            delay,
            easing,
            fill: "backwards",
          },
        ),
      );
      item
        .querySelectorAll(".catalog-tags .badge")
        .forEach((badge, tagIndex) => {
          animations.push(
            badge.animate(
              [
                { opacity: 0, transform: "translateY(4px) scale(0.96)" },
                { opacity: 1, transform: "translateY(0) scale(1)" },
              ],
              {
                id: "sfmcl-t-catalog-tag",
                duration: 200,
                delay: delay + 60 + tagIndex * 35,
                easing,
                fill: "backwards",
              },
            ),
          );
        });
    });
    // Hidden catalogs stay mounted while visiting a detail page. Only a new
    // result set or view starts these animations, so returning preserves focus.
    return () => animations.forEach((animation) => animation.cancel());
  }, [revision, view]);

  return (
    <div
      ref={root}
      id={id}
      className={`catalog-projects ${view} ${className}`}
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function CatalogSkeleton({
  view,
  label,
}: {
  view: ResourceView;
  label: string;
}) {
  return (
    <CatalogItems view={view} label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="catalog-skeleton has-surface"
          aria-hidden="true"
        >
          <PixelFrame />
          <span />
          <div>
            <i />
            <i />
            <i />
          </div>
        </div>
      ))}
    </CatalogItems>
  );
}

export function CatalogResultCount({ text }: { text: string }) {
  const [display, setDisplay] = useState({ text, previous: "", revision: 0 });
  if (display.text !== text) {
    setDisplay({
      text,
      previous: display.text,
      revision: display.revision + 1,
    });
  }
  return (
    <span className="catalog-result-count" role="status" aria-atomic="true">
      {display.previous && (
        <span
          key={`previous-${display.revision}`}
          className="catalog-count-outgoing"
          aria-hidden="true"
          onAnimationEnd={() =>
            setDisplay((current) =>
              current.revision === display.revision
                ? { ...current, previous: "" }
                : current,
            )
          }
        >
          {display.previous}
        </span>
      )}
      <span
        key={display.revision}
        className={display.revision ? "catalog-count-incoming" : ""}
      >
        {display.text}
      </span>
    </span>
  );
}
