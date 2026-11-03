import { useCallback, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { usePageActive } from "./PageActivity";

const timing = {
  duration: 320,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
  fill: "both",
} as const;

export function useVersionViewTransition(enabled: boolean, revision: string) {
  const active = usePageActive();
  const root = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const stop = useCallback(() => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    if (root.current) delete root.current.dataset.versionViewTransition;
  }, []);

  useLayoutEffect(() => stop, [active, enabled, revision, stop]);

  const animateView = useCallback(
    (update: () => void) => {
      const element = root.current;
      if (!element || !active || !enabled || !element.getClientRects().length) {
        stop();
        flushSync(update);
        return;
      }
      const interrupted = animations.current.length > 0;
      const firstHeight = element.getBoundingClientRect().height;
      const before = new Map(
        Array.from(
          element.querySelectorAll<HTMLElement>(".version-card"),
          (item) =>
            [
              item,
              {
                bounds: item.getBoundingClientRect(),
                opacity: getComputedStyle(item).opacity,
                scale: getComputedStyle(item).scale,
              },
            ] as const,
        ),
      );
      // Read the visible frame before canceling an interrupted transition.
      stop();
      flushSync(update);

      const lastHeight = element.getBoundingClientRect().height;
      const next: Animation[] = [];
      if (firstHeight !== lastHeight)
        next.push(
          element.animate(
            [{ height: `${firstHeight}px` }, { height: `${lastHeight}px` }],
            { ...timing, id: "sfmcl-t-version-view-height" },
          ),
        );

      Array.from(
        element.querySelectorAll<HTMLElement>(".version-card"),
      ).forEach((item, index) => {
        const first = before.get(item);
        const last = item.getBoundingClientRect();
        if (!first || !first.bounds.width || !last.width) return;
        next.push(
          item.animate(
            [
              {
                translate: `${first.bounds.left - last.left}px ${first.bounds.top - last.top}px`,
                opacity: interrupted ? first.opacity : 0.35,
                scale:
                  interrupted && first.scale !== "none" ? first.scale : "0.985",
              },
              { translate: "0 0", opacity: 1, scale: "1" },
            ],
            {
              ...timing,
              id: "sfmcl-t-version-view-item",
              delay: Math.min(index, 5) * 18,
            },
          ),
        );
      });
      animations.current = next;
      if (!next.length) return;
      element.dataset.versionViewTransition = "active";
      void Promise.allSettled(next.map((animation) => animation.finished)).then(
        () => {
          if (animations.current === next) stop();
        },
      );
    },
    [active, enabled, stop],
  );

  return { root, animateView };
}
