import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode, RefObject } from "react";

type FooterKind = "launch" | "status";
type IconSnapshot = {
  identity: string;
  center: { x: number; y: number };
  frame: { node: HTMLElement; opacity: string; transform: string };
};
const IconHistory = createContext<{
  kind: FooterKind;
  previous: RefObject<IconSnapshot | null>;
} | null>(null);
const timing = {
  duration: 260,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
  fill: "both",
} as const;

function centerOf(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function captureFrame(node: HTMLElement) {
  const style = getComputedStyle(node);
  const copy = node.cloneNode(true) as HTMLElement;
  copy.style.width = style.width;
  copy.style.height = style.height;
  copy.style.color = style.color;
  // The outgoing copy is static; the live SVG keeps spinning independently.
  const spinner = node.querySelector<SVGElement>(".spin");
  const copiedSpinner = copy.querySelector<SVGElement>(".spin");
  if (spinner && copiedSpinner) {
    copiedSpinner.style.transform = getComputedStyle(spinner).transform;
    copiedSpinner.classList.remove("spin");
  }
  return { node: copy, opacity: style.opacity, transform: style.transform };
}

export function FooterIconProvider({
  kind,
  children,
}: {
  kind: FooterKind;
  children: ReactNode;
}) {
  const previous = useRef<IconSnapshot | null>(null);
  const value = useMemo(() => ({ kind, previous }), [kind]);
  return <IconHistory value={value}>{children}</IconHistory>;
}

export function FooterStatusIcon({
  iconKey,
  children,
}: {
  iconKey: string;
  children: ReactNode;
}) {
  const context = useContext(IconHistory);
  const history = context?.previous;
  const identity = `${context?.kind}:${iconKey}`;
  const host = useRef<HTMLSpanElement>(null);
  const current = useRef<HTMLSpanElement>(null);
  const change = useRef<{
    identity: string;
    previous: IconSnapshot | null;
  } | null>(null);

  useLayoutEffect(() => {
    const container = host.current;
    const icon = current.current;
    if (!history || !container || !icon) return;
    // Preserve the source across React's development effect replay.
    const previous =
      change.current?.identity === identity
        ? change.current.previous
        : history.current;
    change.current = { identity, previous };
    const destination = centerOf(container);
    const snapshot: IconSnapshot = {
      identity,
      center: destination,
      frame: captureFrame(icon),
    };
    history.current = snapshot;
    const animations: Animation[] = [];
    let outgoing: HTMLElement | undefined;

    if (previous && previous.identity !== identity) {
      animations.push(
        container.animate(
          [
            {
              transform: `translate(${previous.center.x - destination.x}px, ${previous.center.y - destination.y}px)`,
            },
            { transform: "translate(0, 0)" },
          ],
          { ...timing, id: "sfmcl-t-footer-icon-position" },
        ),
      );
      outgoing = previous.frame.node.cloneNode(true) as HTMLElement;
      outgoing.className = "footer-icon-outgoing";
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.style.left = `calc(50% - ${parseFloat(outgoing.style.width) / 2}px)`;
      outgoing.style.top = `calc(50% - ${parseFloat(outgoing.style.height) / 2}px)`;
      container.append(outgoing);
      animations.push(
        outgoing.animate(
          [
            {
              opacity: previous.frame.opacity,
              transform: previous.frame.transform,
            },
            { opacity: 0, transform: "rotate(-30deg) scale(0.7)" },
          ],
          { ...timing, id: "sfmcl-t-footer-icon-out" },
        ),
        icon.animate(
          [
            { opacity: 0, transform: "rotate(30deg) scale(0.7)" },
            { opacity: 1, transform: "rotate(0deg) scale(1)" },
          ],
          { ...timing, id: "sfmcl-t-footer-icon-in" },
        ),
      );
    }

    const clear = () => {
      outgoing?.remove();
      animations.forEach((animation) => animation.cancel());
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      clear,
      () => {},
    );
    return () => {
      snapshot.center = centerOf(container);
      const useOutgoing =
        outgoing?.isConnected &&
        Number(getComputedStyle(outgoing).opacity) >
          Number(getComputedStyle(icon).opacity);
      if (useOutgoing && outgoing) {
        snapshot.frame = captureFrame(outgoing);
      } else {
        // React may already have replaced the SVG before layout cleanup. Keep
        // the committed graphic and sample only its still-running wrapper motion.
        const visible = getComputedStyle(icon);
        snapshot.frame.opacity = visible.opacity;
        snapshot.frame.transform = visible.transform;
      }
      clear();
    };
  }, [history, identity]);

  return (
    <span
      ref={host}
      className="footer-status-icon"
      data-footer-icon={iconKey}
      aria-hidden="true"
    >
      <span ref={current} className="footer-icon-current">
        {children}
      </span>
    </span>
  );
}
