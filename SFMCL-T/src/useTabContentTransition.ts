import { useLayoutEffect, useRef } from "react";

export function useTabContentTransition(
  index: number,
  enabled = true,
  {
    duration = 240,
    distance = 16,
    initialOpacity = 0.15,
  }: { duration?: number; distance?: number; initialOpacity?: number } = {},
) {
  const content = useRef<HTMLDivElement>(null);
  const previous = useRef({ index, enabled });

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { index, enabled };
    // Initial renders, data updates and detail returns have their own motion.
    if (last.index === index || !last.enabled || !enabled || !content.current)
      return;

    const direction = index > last.index ? 1 : -1;
    const animation = content.current.animate(
      [
        {
          opacity: initialOpacity,
          transform: `translateX(${direction * distance}px)`,
        },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        id: "sfmcl-t-resource-tab",
        duration,
        easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
        fill: "both",
      },
    );
    const cleanup = () => animation.cancel();
    void animation.finished.then(cleanup, cleanup);
    return cleanup;
  }, [index, enabled, duration, distance, initialOpacity]);

  return content;
}
