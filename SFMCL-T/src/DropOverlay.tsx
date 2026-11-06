import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PixelFrame } from "./components";
import "./modpack-drop.css";

export function useDropOverlay<Phase extends string>(
  phase: Phase,
  kind: string,
) {
  const overlay = useRef<HTMLDivElement>(null);
  const visible = phase !== "idle";
  const [displayPhase, setDisplayPhase] = useState<string>(phase);
  if (visible && displayPhase !== phase) setDisplayPhase(phase);
  const present = displayPhase !== "idle";

  useLayoutEffect(() => {
    const element = overlay.current;
    if (!present || !element) return;
    const open = element.matches(":popover-open");
    const from = open ? getComputedStyle(element).opacity : "0";
    const content = element.querySelector<HTMLElement>(".modpack-drop-content");
    const contentFrom =
      open && content
        ? getComputedStyle(content).transform
        : "translateY(12px) scale(0.99)";
    // Both importers retain their top-layer placeholder through the exit motion.
    if (!open) element.showPopover();
    const timing = {
      duration: visible ? 240 : 200,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both" as FillMode,
    };
    const animations = [
      element.animate([{ opacity: from }, { opacity: visible ? 0.75 : 0 }], {
        ...timing,
        id: `sfmcl-t-${kind}-drop-${visible ? "enter" : "exit"}`,
      }),
    ];
    if (content)
      animations.push(
        content.animate(
          [
            { transform: contentFrom },
            {
              transform: visible
                ? "translateY(0) scale(1)"
                : "translateY(8px) scale(0.99)",
            },
          ],
          { ...timing, id: `sfmcl-t-${kind}-drop-content` },
        ),
      );
    let cancelled = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (cancelled || visible) return;
        element.hidePopover();
        setDisplayPhase("idle");
      },
      () => {},
    );
    return () => {
      cancelled = true;
      element.style.opacity = getComputedStyle(element).opacity;
      if (content)
        content.style.transform = getComputedStyle(content).transform;
      animations.forEach((animation) => animation.cancel());
    };
  }, [present, visible, kind]);

  return { overlay, visible, present, displayPhase };
}

export function DropOverlay({
  motion,
  kind,
  icon,
  eyebrow,
  title,
  description,
  detail,
  detailTooltip,
  formats,
  hint,
}: {
  motion: ReturnType<typeof useDropOverlay>;
  kind: string;
  icon: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  detail?: string;
  detailTooltip?: string;
  formats: string;
  hint: string;
}) {
  if (!motion.present) return null;
  return (
    <div
      ref={motion.overlay}
      popover="manual"
      className={`drop-overlay ${kind}-drop-overlay`}
      data-phase={motion.displayPhase}
      data-exiting={!motion.visible || undefined}
      role="status"
      aria-live="polite"
      aria-hidden={!motion.visible || undefined}
      aria-busy={motion.visible && motion.displayPhase === "checking"}
    >
      <div className="modpack-drop-frame has-surface">
        <PixelFrame />
        <div className="modpack-drop-content">
          <span className="modpack-drop-icon has-surface" aria-hidden="true">
            <PixelFrame />
            {icon}
          </span>
          <span className="modpack-drop-eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
          {detail && (
            <strong
              className="modpack-drop-filename"
              data-tooltip={detailTooltip}
            >
              {detail}
            </strong>
          )}
          <p className="modpack-drop-formats">{formats}</p>
        </div>
        <span className="modpack-drop-hint">{hint}</span>
      </div>
    </div>
  );
}
