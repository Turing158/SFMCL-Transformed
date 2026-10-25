import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import { PixelFrame } from "./components";
import {
  NOTIFICATION_EXIT_DURATION,
  NOTIFICATION_LIFETIME,
} from "./notifications";
import type { Notification } from "./notifications";
import "./notifications.css";

const CARD_GAP = 8;
const DEFAULT_HEIGHT = 56;

export function NotificationDeck({
  notifications,
  onDismiss,
}: {
  notifications: Notification[];
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touch, setTouch] = useState(
    () => window.matchMedia("(hover: none)").matches,
  );
  const [heights, setHeights] = useState<Record<number, number>>({});
  const expanded = hovered || focused || touch;
  const measure = useCallback((id: number, height: number | null) => {
    setHeights((current) => {
      if (height === null) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return current[id] === height ? current : { ...current, [id]: height };
    });
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(hover: none)");
    const update = () => setTouch(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (notifications.length === 0) {
      setHovered(false);
      setFocused(false);
    }
  }, [notifications.length]);

  const frontHeight = heights[notifications[0]?.id] ?? DEFAULT_HEIGHT;
  let offset = 0;
  const layout = notifications.map((notification, index) => {
    const height = heights[notification.id] ?? DEFAULT_HEIGHT;
    const item = {
      notification,
      index,
      height: expanded ? height : frontHeight,
      offset: expanded ? offset : Math.min(index, 2) * CARD_GAP,
    };
    offset += height + CARD_GAP;
    return item;
  });
  const deckHeight = expanded
    ? offset - CARD_GAP
    : frontHeight + Math.min(notifications.length - 1, 2) * CARD_GAP;

  return (
    <section
      className="notification-deck"
      aria-label="通知"
      data-expanded={expanded}
      hidden={notifications.length === 0}
      style={
        {
          "--deck-height": `${deckHeight + 16}px`,
          "--notification-lifetime": `${NOTIFICATION_LIFETIME}ms`,
          "--notification-exit-duration": `${NOTIFICATION_EXIT_DURATION}ms`,
        } as CSSProperties
      }
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (event.target.matches(":focus-visible")) setFocused(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div className="notification-viewport">
        <div className="notification-cards">
          {layout.map(({ notification, index, height, offset }) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              index={index}
              count={notifications.length}
              expanded={expanded}
              height={height}
              offset={offset}
              onMeasure={measure}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function NotificationCard({
  notification,
  index,
  count,
  expanded,
  height,
  offset,
  onMeasure,
  onDismiss,
}: {
  notification: Notification;
  index: number;
  count: number;
  expanded: boolean;
  height: number;
  offset: number;
  onMeasure: (id: number, height: number | null) => void;
  onDismiss: (id: number) => void;
}) {
  const body = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exit, setExit] = useState<"click" | "timeout" | null>(null);
  const paused = hovered || focused;
  const covered = !expanded && index > 0;
  const { id, kind, message } = notification;

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () =>
      onMeasure(id, Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onMeasure(id, null);
    };
  }, [id, onMeasure]);

  // Each mounted card owns its timer. Leaving hover/focus starts a fresh 5 s.
  useEffect(() => {
    if (paused || exit) return;
    const timer = window.setTimeout(
      () => setExit("timeout"),
      NOTIFICATION_LIFETIME,
    );
    return () => window.clearTimeout(timer);
  }, [paused, exit]);

  useEffect(() => {
    if (!exit) return;
    const timer = window.setTimeout(
      () => onDismiss(id),
      NOTIFICATION_EXIT_DURATION,
    );
    return () => window.clearTimeout(timer);
  }, [exit, id, onDismiss]);

  return (
    <div
      className="notification-slot"
      data-covered={covered}
      data-hidden={!expanded && index > 2}
      data-notification-id={id}
      aria-hidden={covered || !!exit}
      inert={covered || !!exit}
      style={
        {
          "--card-offset": `${-offset}px`,
          "--card-inset": `${expanded ? 0 : Math.min(index, 2) * 8}px`,
          height,
          zIndex: count - index,
        } as CSSProperties
      }
    >
      <div className="notification-motion" data-state={exit ?? "visible"}>
        <button
          type="button"
          className={`toast ${kind} has-surface`}
          aria-label={`关闭通知：${message}`}
          data-paused={paused}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") setHovered(true);
          }}
          onPointerLeave={() => setHovered(false)}
          onFocus={(event) =>
            setFocused(event.currentTarget.matches(":focus-visible"))
          }
          onBlur={() => setFocused(false)}
          onClick={() => setExit("click")}
        >
          <PixelFrame />
          <span ref={body} className="notification-body">
            <span className="notification-icon has-surface" aria-hidden="true">
              <PixelFrame />
              {kind === "success" ? (
                <Check size={16} />
              ) : (
                <span className="notification-error-mark">!</span>
              )}
            </span>
            <span
              className="notification-message"
              role={kind === "error" ? "alert" : "status"}
              aria-atomic="true"
            >
              {message}
            </span>
          </span>
          <span className="notification-lifetime" aria-hidden="true">
            <span key={paused ? "paused" : "counting"} />
          </span>
        </button>
      </div>
    </div>
  );
}
