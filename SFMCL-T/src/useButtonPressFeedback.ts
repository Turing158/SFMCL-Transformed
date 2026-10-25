import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";

export function useButtonPressFeedback(id: string) {
  const feedback = useRef(new Map<Element, Animation>());
  useEffect(
    () => () => {
      feedback.current.forEach((animation) => animation.cancel());
      feedback.current.clear();
    },
    [],
  );

  return (event: MouseEvent<HTMLElement>) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null;
    // Switches animate their own thumb; moving the whole control interrupts it.
    if (!button || button.matches(':disabled, [role="switch"]')) return;
    // Keep tab labels above the shared indicator; never transform the tab itself.
    const target =
      button.getAttribute("role") === "tab"
        ? button.querySelector(".tab-content")
        : button;
    if (!target) return;
    feedback.current.get(target)?.cancel();
    const animation = target.animate(
      [
        { translate: "0 0" },
        { translate: "0 2px", offset: 0.4 },
        { translate: "0 0" },
      ],
      { id, duration: 180, easing: "cubic-bezier(0.22, 0.8, 0.25, 1)" },
    );
    feedback.current.set(target, animation);
    void animation.finished.then(
      () => {
        if (feedback.current.get(target) === animation)
          feedback.current.delete(target);
      },
      () => {},
    );
  };
}
