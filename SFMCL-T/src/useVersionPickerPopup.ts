import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

export function useVersionPickerPopup(
  popup: RefObject<HTMLDivElement | null>,
  actions: RefObject<HTMLDivElement | null>,
  open: boolean,
  onExited: () => void,
) {
  const motion = useRef<Animation | null>(null);
  const exited = useRef(onExited);
  exited.current = onExited;

  useLayoutEffect(() => {
    const panel = popup.current;
    const anchor =
      actions.current?.querySelector<HTMLButtonElement>(".launch-switch");
    if (!panel || !anchor) return;
    if ("showPopover" in panel) panel.showPopover();

    const gap = 6;
    const margin = 8;
    let previous = "";
    const geometry = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + margin;
      const right = left + (viewport?.width ?? innerWidth) - margin * 2;
      const top = Math.max(
        (viewport?.offsetTop ?? 0) + margin,
        (document.querySelector(".topbar")?.getBoundingClientRect().bottom ??
          0) + margin,
      );
      const bottom =
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - margin;
      const key = [
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        left,
        right,
        top,
        bottom,
      ].join(",");
      return { rect, left, right, top, bottom, key };
    };
    const position = (bounds = geometry()) => {
      const { rect, left, right, top, bottom, key } = bounds;
      previous = key;
      panel.style.width = `${Math.max(0, Math.min(400, right - left))}px`;
      // Measure the natural, capped list height before choosing the roomier side.
      panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
      const ideal = panel.offsetHeight;
      const above = Math.max(0, rect.top - gap - top);
      const below = Math.max(0, bottom - rect.bottom - gap);
      const upward = below < ideal && above > below;
      panel.style.maxHeight = `${upward ? above : below}px`;
      const style = getComputedStyle(panel);
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      const x = Math.max(left, Math.min(rect.right - width, right - width));
      panel.style.left = `${x}px`;
      panel.style.top = `${upward ? rect.top - height - gap : rect.bottom + gap}px`;
      panel.dataset.placement = upward ? "top" : "bottom";
      panel.style.transformOrigin = `${Math.max(0, Math.min(width, rect.left + rect.width / 2 - x))}px ${upward ? "bottom" : "top"}`;
      panel.style.setProperty(
        "--launch-picker-offset",
        upward ? "8px" : "-8px",
      );
    };
    position();
    const observer = new ResizeObserver(() => position());
    observer.observe(anchor);
    observer.observe(panel);
    // Footer and sidebar animations move the anchor without resizing it.
    let frame = 0;
    const follow = () => {
      const bounds = geometry();
      if (previous !== bounds.key) position(bounds);
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.current?.cancel();
      motion.current = null;
      if ("hidePopover" in panel && panel.matches(":popover-open"))
        panel.hidePopover();
    };
  }, [popup, actions]);

  useLayoutEffect(() => {
    const panel = popup.current;
    if (!panel) return;
    const style = getComputedStyle(panel);
    const collapsed = {
      opacity: 0,
      transform: `translateY(${style.getPropertyValue("--launch-picker-offset").trim()}) scale(0.96)`,
      filter: "drop-shadow(0 0 0 transparent) drop-shadow(0 0 0 transparent)",
    };
    // Preserve the painted frame when an opening/closing animation reverses.
    const from =
      motion.current || !open
        ? {
            opacity: style.opacity,
            transform: style.transform,
            filter: style.filter,
          }
        : collapsed;
    motion.current?.cancel();
    const animation = panel.animate(
      [
        from,
        open
          ? {
              opacity: 1,
              transform: "translateY(0) scale(1)",
              filter: style.getPropertyValue("--launch-picker-shadow").trim(),
            }
          : collapsed,
      ],
      {
        id: "sfmcl-t-version-picker",
        duration: open ? 240 : 180,
        easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
        fill: "both",
      },
    );
    motion.current = animation;
    animation.onfinish = () => {
      if (motion.current !== animation) return;
      if (open) {
        motion.current = null;
        animation.cancel();
      } else exited.current();
    };
  }, [open, popup]);
}
