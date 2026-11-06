import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

export function useSelectPopupMotion(
  popup: RefObject<HTMLDivElement | null>,
  open: boolean,
  present: boolean,
  positioned: boolean,
  setPresent: (present: boolean) => void,
) {
  const popupMotion = useRef<Animation | null>(null);

  useLayoutEffect(
    () => () => {
      popupMotion.current?.cancel();
      popupMotion.current = null;
    },
    [present],
  );

  useLayoutEffect(() => {
    const panel = popup.current;
    if (!present || !positioned || !panel) return;
    const style = getComputedStyle(panel);
    const collapsed = {
      opacity: 0,
      clipPath: style.getPropertyValue("--select-collapsed-clip").trim(),
      transform: `translateY(${style.getPropertyValue("--select-offset").trim()})`,
    };
    const expanded = {
      opacity: 1,
      clipPath: "inset(-8px)",
      transform: "translateY(0px)",
    };
    // Read the current frame before cancelling so rapid toggles reverse smoothly.
    const from =
      popupMotion.current || !open
        ? {
            opacity: style.opacity,
            clipPath: style.clipPath,
            transform: style.transform,
          }
        : collapsed;
    popupMotion.current?.cancel();
    const animation = panel.animate([from, open ? expanded : collapsed], {
      id: "sfmcl-t-select-popup",
      duration: open ? 220 : 160,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both",
    });
    popupMotion.current = animation;
    animation.onfinish = () => {
      if (popupMotion.current !== animation) return;
      if (open) {
        popupMotion.current = null;
        animation.cancel();
      } else setPresent(false);
    };
  }, [open, present, positioned, popup, setPresent]);
}
