import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const timing = {
  duration: 300,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
  fill: "both",
  id: "sfmcl-t-launch-disclosure",
} as const;

export function useLaunchDisclosure({
  host,
  expanded,
  dragHeight,
  active,
  count,
}: {
  host: RefObject<HTMLElement | null>;
  expanded: boolean;
  dragHeight: number | null;
  active: boolean;
  count: number;
}) {
  const clip = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const destination = useRef(0);
  const initialized = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ expanded, dragHeight, active });
  latest.current = { expanded, dragHeight, active };

  const clearAnimation = useCallback(() => {
    animation.current?.cancel();
    animation.current = null;
    if (host.current) delete host.current.dataset.disclosureAnimating;
  }, [host]);

  const freeze = useCallback(() => {
    const node = clip.current;
    const height =
      node && !node.hidden ? parseFloat(getComputedStyle(node).height) : 0;
    clearAnimation();
    if (node) node.style.height = `${height}px`;
    return height;
  }, [clearAnimation]);

  const sync = useCallback(() => {
    const node = clip.current;
    const state = latest.current;
    if (!node) {
      clearAnimation();
      initialized.current = null;
      return;
    }
    if (state.dragHeight !== null) {
      clearAnimation();
      node.hidden = false;
      node.style.height = `${state.dragHeight}px`;
      return;
    }
    if (initialized.current === node && node.hidden && !state.expanded) return;

    const from = node.hidden ? 0 : parseFloat(getComputedStyle(node).height);
    node.hidden = false;
    const natural =
      (node.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    const to = state.expanded ? natural : 0;
    if (state.active && animation.current && destination.current === to) return;
    clearAnimation();
    node.style.height = `${to}px`;
    destination.current = to;
    if (
      initialized.current !== node ||
      !state.active ||
      Math.abs(from - to) < 0.5
    ) {
      initialized.current = node;
      node.hidden = to === 0;
      return;
    }

    // Keep the full content mounted behind the animated clip in both directions.
    // Reading the current painted height before cancellation also makes reversals continuous.
    if (host.current) host.current.dataset.disclosureAnimating = "true";
    const next = node.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      timing,
    );
    animation.current = next;
    void next.finished.then(
      () => {
        if (animation.current !== next) return;
        clearAnimation();
        node.hidden = to === 0;
      },
      () => {},
    );
  }, [clearAnimation, host]);

  useLayoutEffect(sync, [active, expanded, dragHeight, count, sync]);

  useLayoutEffect(() => {
    const content = clip.current?.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(sync);
    observer.observe(content);
    return () => observer.disconnect();
  }, [count, sync]);

  useLayoutEffect(() => clearAnimation, [clearAnimation]);

  return { clip, freeze, resume: sync };
}
