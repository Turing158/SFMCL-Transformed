import { useCallback, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { FooterTextProvider } from "./FooterText";
import { FooterIconProvider } from "./FooterStatusIcon";

export function WorkspaceFooter({
  kind,
  children,
}: {
  kind: "launch" | "status";
  children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const targetHeight = useRef<number | null>(null);
  const transition = useRef<Animation | null>(null);

  const resize = useCallback((animate: boolean) => {
    const host = region.current;
    const inner = content.current;
    if (!host || !inner) return;
    const next = inner.getBoundingClientRect().height;
    if (targetHeight.current === next) return;

    // Read the visible height before cancelling an interrupted transition.
    const from = host.getBoundingClientRect().height;
    const initialized = targetHeight.current !== null;
    targetHeight.current = next;
    transition.current?.cancel();
    transition.current = null;
    host.style.height = `${next}px`;
    delete host.dataset.resizing;
    if (!animate || !initialized || Math.abs(from - next) < 0.5) return;

    host.dataset.resizing = "true";
    const animation = host.animate(
      [{ height: `${from}px` }, { height: `${next}px` }],
      {
        id: "sfmcl-t-footer-height",
        duration: 260,
        easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      },
    );
    transition.current = animation;
    void animation.finished.then(
      () => {
        if (transition.current !== animation) return;
        transition.current = null;
        delete host.dataset.resizing;
      },
      () => {},
    );
  }, []);

  useLayoutEffect(() => resize(true), [kind, resize]);

  useLayoutEffect(() => {
    const inner = content.current;
    if (!inner) return;
    // Resizing the window updates the natural size; an active transition retargets.
    const observer = new ResizeObserver(() => resize(!!transition.current));
    observer.observe(inner);
    return () => {
      observer.disconnect();
      transition.current?.cancel();
      transition.current = null;
    };
  }, [resize]);

  return (
    <div ref={region} className="workspace-footer-region" data-kind={kind}>
      <div ref={content} className="workspace-footer-content">
        <FooterIconProvider kind={kind}>
          <FooterTextProvider kind={kind}>{children}</FooterTextProvider>
        </FooterIconProvider>
      </div>
    </div>
  );
}
