import { useCallback, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { usePageActive } from "./PageActivity";

const duration = 420;
const easing = "cubic-bezier(0.22, 0.8, 0.25, 1)";
const layoutTargets = ".player-preview, .players-collection";

export function usePlayerViewTransition() {
  const pageActive = usePageActive();
  const root = useRef<HTMLDivElement>(null);
  const transition = useRef<ViewTransition | null>(null);
  const animations = useRef<Animation[]>([]);

  useLayoutEffect(
    () => () => {
      transition.current?.skipTransition();
      transition.current = null;
      animations.current.forEach((animation) => animation.cancel());
      delete document.documentElement.dataset.playerViewTransition;
    },
    [pageActive],
  );

  const animateView = useCallback((update: () => void) => {
    transition.current?.skipTransition();
    const element = root.current;
    if (!element) return;

    const commit = () => {
      if (root.current?.isConnected) flushSync(update);
    };

    if (typeof document.startViewTransition === "function") {
      document.documentElement.dataset.playerViewTransition = "active";
      const next = document.startViewTransition(async () => {
        commit();
        const scene = root.current?.querySelector<HTMLImageElement>(
          ".players-scenery img",
        );
        await scene?.decode().catch(() => {});
      });
      transition.current = next;
      // Rapid toggles and leaving the page can skip a pending snapshot.
      void next.ready.catch(() => {});
      const finish = () => {
        if (transition.current !== next) return;
        transition.current = null;
        delete document.documentElement.dataset.playerViewTransition;
      };
      void next.finished.then(finish, finish);
      return;
    }

    // Older WebView2 runtimes animate the same two regions with FLIP.
    const before = new Map(
      Array.from(
        element.querySelectorAll<HTMLElement>(layoutTargets),
        (node) => [node, node.getBoundingClientRect()] as const,
      ),
    );
    animations.current.forEach((animation) => animation.cancel());
    commit();
    animations.current = Array.from(before, ([node, first]) => {
      const last = node.getBoundingClientRect();
      if (!first.width || !first.height || !last.width || !last.height)
        return null;
      return node.animate(
        [
          {
            transformOrigin: "top left",
            transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`,
          },
          { transformOrigin: "top left", transform: "none" },
        ],
        { duration, easing },
      );
    }).filter((animation): animation is Animation => animation !== null);
  }, []);

  return { root, animateView };
}
