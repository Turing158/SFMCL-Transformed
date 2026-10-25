import { useState } from "react";
import type { ReactNode } from "react";

/** Keep the committed content long enough to animate it out on a real change. */
export function AnimatedSwap({
  value,
  children,
  className = "",
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const [display, setDisplay] = useState({
    value,
    content: children,
    previous: null as ReactNode,
    revision: 0,
  });
  let current = display;
  if (display.value !== value) {
    current = {
      value,
      content: children,
      previous: display.content,
      revision: display.revision + 1,
    };
    setDisplay(current);
  }
  return (
    <span className={`animated-swap ${className}`}>
      {current.previous != null && (
        <span
          key={`out-${current.revision}`}
          className="animated-swap-out"
          aria-hidden="true"
        >
          {current.previous}
        </span>
      )}
      <span
        key={current.revision}
        className={current.revision ? "animated-swap-in" : ""}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          setDisplay((latest) =>
            latest.revision === current.revision
              ? { ...latest, previous: null }
              : latest,
          );
        }}
      >
        {children}
      </span>
    </span>
  );
}
