import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import "./loading-state.css";

const easing = "cubic-bezier(0.22, 0.8, 0.25, 1)";
const visible = { opacity: 1, transform: "translateY(0) scale(1)" };
const hiddenIcon = { opacity: 0, transform: "translateY(6px) scale(0.86)" };
const hiddenText = { opacity: 0, transform: "translateY(5px) scale(1)" };

/** Finish the indicator's exit before revealing the latest result or error. */
export function LoadingState({
  loading,
  label,
  children,
}: {
  loading: boolean;
  label: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(loading);
  const icon = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const poses = useRef<Keyframe[] | null>(null);
  const showing = loading || present;

  useLayoutEffect(() => {
    if (!showing || !icon.current || !text.current) return;
    if (loading) setPresent(true);
    const elements = [icon.current, text.current];
    const hidden = [hiddenIcon, hiddenText];
    const from = poses.current ?? (loading ? hidden : [visible, visible]);
    const animations = elements.map((element, index) =>
      element.animate([from[index], loading ? visible : hidden[index]], {
        id: `sfmcl-t-loading-${index === 0 ? "icon" : "text"}-${loading ? "in" : "out"}`,
        duration: loading ? (index === 0 ? 240 : 200) : index === 0 ? 180 : 150,
        delay: loading ? (index === 0 ? 0 : 45) : index === 0 ? 30 : 0,
        easing,
        fill: "both",
      }),
    );
    let disposed = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (!disposed && !loading) {
          poses.current = null;
          setPresent(false);
        }
      },
      () => {},
    );
    return () => {
      disposed = true;
      // Continue from the painted pose if a refresh reverses an unfinished exit.
      poses.current = elements[0].isConnected
        ? elements.map((element) => {
            const style = getComputedStyle(element);
            return { opacity: style.opacity, transform: style.transform };
          })
        : null;
      animations.forEach((animation) => animation.cancel());
    };
  }, [loading, showing]);

  return (
    <div className="loading-region" aria-busy={loading}>
      {showing ? (
        <div
          className="loading-state"
          data-loading={loading}
          role={loading ? "status" : undefined}
          aria-live={loading ? "polite" : "off"}
          aria-atomic="true"
          aria-hidden={!loading}
        >
          <span ref={icon} className="loading-state-icon" aria-hidden="true">
            <LoaderCircle className="loading-state-spinner" size={30} />
          </span>
          <span ref={text} className="loading-state-text">
            {label}
          </span>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
