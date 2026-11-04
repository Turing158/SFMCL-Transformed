import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ComponentProps, ReactNode } from "react";
import { footerFrames, footerTiming } from "./footerMotion";

type TextSlot = "message" | "player" | "step";
type FooterKind = "launch" | "status";
type TextFrame = { text: string; opacity: string; top: string };
type TextSnapshot = {
  text: string;
  kind: FooterKind;
  frame: TextFrame;
  position: { x: number; y: number };
};
const TextHistory = createContext<{
  kind: FooterKind;
  history: Map<TextSlot, TextSnapshot>;
} | null>(null);
export function FooterTextProvider({
  kind,
  children,
}: {
  kind: FooterKind;
  children: ReactNode;
}) {
  // Keep the last visible line when navigation replaces the entire footer.
  const history = useRef(new Map<TextSlot, TextSnapshot>());
  const value = useMemo(() => ({ kind, history: history.current }), [kind]);
  return <TextHistory value={value}>{children}</TextHistory>;
}

export function FooterText({
  slot,
  text,
  className = "",
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  slot: TextSlot;
  text: string;
}) {
  const context = useContext(TextHistory);
  const history = context?.history;
  const kind = context?.kind;
  const host = useRef<HTMLSpanElement>(null);
  const current = useRef<HTMLSpanElement>(null);
  const change = useRef<{
    text: string;
    kind: FooterKind;
    previous: TextSnapshot | undefined;
  } | null>(null);

  useLayoutEffect(() => {
    const container = host.current;
    const line = current.current;
    if (!history || !kind || !container || !line) return;
    // Effect replay must retain the source line instead of treating it as unchanged.
    const previous =
      change.current?.text === text && change.current.kind === kind
        ? change.current.previous
        : history.get(slot);
    change.current = { text, kind, previous };
    const target = container.getBoundingClientRect();
    const snapshot: TextSnapshot = {
      text,
      kind,
      frame: { text, opacity: "1", top: "0px" },
      position: { x: target.x, y: target.y },
    };
    history.set(slot, snapshot);
    const animations: Animation[] = [];
    let outgoing: HTMLSpanElement | undefined;

    // Layout offsets and painted alpha keep glyphs out of a second GPU texture.
    // The status line has different icon spacing and vertical alignment in each
    // footer. Move from its visible origin even when both say "准备就绪".
    if (slot === "message" && previous && text) {
      const x = previous.position.x - target.x;
      const y = previous.position.y - target.y;
      // A live status update can interrupt this move before navigation settles.
      if (previous.kind !== kind || Math.abs(x) + Math.abs(y) > 0.1) {
        animations.push(
          container.animate(
            footerFrames(
              { left: `${x}px`, top: `${y}px` },
              { left: "0px", top: "0px" },
            ),
            { ...footerTiming, id: "sfmcl-t-footer-text-position" },
          ),
        );
      }
    }

    if (previous && previous.text !== text && text) {
      if (previous.frame.text) {
        outgoing = document.createElement("span");
        outgoing.className = "footer-text-outgoing";
        outgoing.dataset.text = previous.frame.text;
        outgoing.setAttribute("aria-hidden", "true");
        container.append(outgoing);
        animations.push(
          outgoing.animate(
            footerFrames(
              {
                "--footer-text-alpha": previous.frame.opacity,
                top: previous.frame.top,
              },
              { "--footer-text-alpha": 0, top: "-6px" },
            ),
            { ...footerTiming, id: "sfmcl-t-footer-text-out" },
          ),
        );
      }
      animations.push(
        line.animate(
          footerFrames(
            { "--footer-text-alpha": 0, top: "6px" },
            { "--footer-text-alpha": 1, top: "0px" },
          ),
          { ...footerTiming, id: "sfmcl-t-footer-text-in" },
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
      const visiblePosition = container.getBoundingClientRect();
      snapshot.position = { x: visiblePosition.x, y: visiblePosition.y };
      // Rapid changes continue from the most visible line, without stacking ghosts.
      const incomingStyle = getComputedStyle(line);
      const outgoingStyle = outgoing?.isConnected
        ? getComputedStyle(outgoing)
        : null;
      const useOutgoing =
        outgoingStyle &&
        Number(outgoingStyle.opacity) > Number(incomingStyle.opacity);
      const visible = useOutgoing ? outgoingStyle : incomingStyle;
      snapshot.frame = {
        text: useOutgoing ? previous!.frame.text : text,
        opacity: visible.opacity,
        top: visible.top,
      };
      clear();
    };
  }, [history, kind, slot, text]);

  return (
    <span
      {...props}
      ref={host}
      className={`footer-text ${className}`}
      data-footer-text={slot}
    >
      <span ref={current} className="footer-text-current">
        {text}
      </span>
    </span>
  );
}
