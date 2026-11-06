import { useCallback, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { FooterTextProvider } from "./FooterText";
import { FooterIconProvider } from "./FooterStatusIcon";
import { footerFrames, footerTiming } from "./footerMotion";

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
  const statusHeight = useRef<number | null>(null);
  const cardHeight = useRef<number | null>(null);
  const currentKind = useRef(kind);
  currentKind.current = kind;
  const transition = useRef<Animation | null>(null);

  const resize = useCallback((animate: boolean) => {
    const host = region.current;
    const inner = content.current;
    if (!host || !inner) return;
    const card = inner.querySelector<HTMLElement>(".launch-dock-main");
    // Hover scaling must not change the footer's layout or slide distance.
    const nextCard = card?.offsetHeight ?? 0;
    const cardScale = card ? parseFloat(getComputedStyle(card).scale) || 1 : 1;
    const status = inner.querySelector<HTMLElement>(
      ".launch-status, .workspace-footer",
    );
    const nextStatus = status?.getBoundingClientRect().height ?? 0;
    const launch = currentKind.current === "launch";
    const next = launch ? inner.getBoundingClientRect().height : nextStatus;
    const nextOffset = launch ? 0 : nextCard;
    const nextAlpha = launch ? 1 : 0;
    if (
      targetHeight.current === next &&
      statusHeight.current === nextStatus &&
      cardHeight.current === nextCard
    )
      return;

    // Read the visible height before cancelling an interrupted transition.
    const from = host.getBoundingClientRect().height;
    const fromAlpha = parseFloat(
      getComputedStyle(host).getPropertyValue("--launch-card-alpha"),
    );
    const fromStatus =
      statusHeight.current === null
        ? nextStatus
        : parseFloat(
            getComputedStyle(host).getPropertyValue("--footer-status-height"),
          );
    // The retained card's baseline moves when the status strip or responsive
    // layout changes. Compensate before retargeting to keep its painted origin.
    const fromOffset =
      cardHeight.current === null
        ? nextOffset
        : parseFloat(
            getComputedStyle(host).getPropertyValue("--launch-card-offset"),
          ) +
          (nextCard - cardHeight.current) * cardScale +
          nextStatus -
          (statusHeight.current ?? nextStatus);
    const initialized = targetHeight.current !== null;
    targetHeight.current = next;
    statusHeight.current = nextStatus;
    cardHeight.current = nextCard;
    transition.current?.cancel();
    transition.current = null;
    host.style.height = `${next}px`;
    host.style.setProperty("--footer-region-height", `${next}px`);
    host.style.setProperty("--footer-status-height", `${nextStatus}px`);
    host.style.setProperty("--launch-card-offset", `${nextOffset}px`);
    host.style.setProperty("--launch-card-alpha", String(nextAlpha));
    delete host.dataset.resizing;
    if (
      !animate ||
      !initialized ||
      (Math.abs(from - next) < 0.5 &&
        Math.abs(fromStatus - nextStatus) < 0.5 &&
        Math.abs(fromOffset - nextOffset) < 0.5 &&
        Math.abs(fromAlpha - nextAlpha) < 0.001)
    )
      return;

    host.dataset.resizing = "true";
    const animation = host.animate(
      footerFrames(
        {
          height: `${from}px`,
          "--footer-region-height": `${from}px`,
          "--footer-status-height": `${fromStatus}px`,
          "--launch-card-offset": `${fromOffset}px`,
          "--launch-card-alpha": fromAlpha,
        },
        {
          height: `${next}px`,
          "--footer-region-height": `${next}px`,
          "--footer-status-height": `${nextStatus}px`,
          "--launch-card-offset": `${nextOffset}px`,
          "--launch-card-alpha": nextAlpha,
        },
      ),
      {
        ...footerTiming,
        id: "sfmcl-t-footer-height",
      },
    );
    transition.current = animation;
    void animation.finished.then(
      () => {
        if (transition.current !== animation) return;
        transition.current = null;
        animation.cancel();
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
      <div className="workspace-footer-clip">
        <div ref={content} className="workspace-footer-content">
          <FooterIconProvider kind={kind}>
            <FooterTextProvider kind={kind}>{children}</FooterTextProvider>
          </FooterIconProvider>
        </div>
      </div>
    </div>
  );
}
