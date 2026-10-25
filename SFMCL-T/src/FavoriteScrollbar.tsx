import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

export function FavoriteScrollbar({
  list,
  listId,
  contentKey,
}: {
  list: RefObject<HTMLOListElement | null>;
  listId: string;
  contentKey: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const [metrics, setMetrics] = useState({ height: 0, content: 0, top: 0 });
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = list.current;
    const bar = track.current;
    if (!element || !bar) return;
    let idle: number | undefined;
    setScrolling(false);
    setDragging(false);
    const measure = () => {
      const next = {
        height: element.clientHeight,
        content: element.scrollHeight,
        top: element.scrollTop,
      };
      setMetrics((previous) =>
        previous.height === next.height &&
        previous.content === next.content &&
        previous.top === next.top
          ? previous
          : next,
      );
    };
    const activity = () => {
      setScrolling(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => setScrolling(false), 900);
    };
    const scroll = () => {
      measure();
      activity();
    };
    const wheel = (event: WheelEvent) => {
      if (element.scrollHeight <= element.clientHeight) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1;
      element.scrollTop += event.deltaY * unit;
    };
    measure();
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("wheel", activity, { passive: true });
    // The track is beside the scrollport, so forward wheel input to the list.
    bar.addEventListener("wheel", wheel, { passive: false });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    Array.from(element.children).forEach((item) => observer.observe(item));
    return () => {
      window.clearTimeout(idle);
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("wheel", activity);
      bar.removeEventListener("wheel", wheel);
      observer.disconnect();
      if (drag.current && bar.hasPointerCapture(drag.current.pointerId))
        bar.releasePointerCapture(drag.current.pointerId);
      drag.current = null;
    };
  }, [list, contentKey]);

  const range = Math.max(0, metrics.content - metrics.height);
  const canScroll = metrics.height > 0 && range > 1;
  const thumbHeight = canScroll
    ? Math.min(
        metrics.height,
        Math.max(24, (metrics.height * metrics.height) / metrics.content),
      )
    : 0;
  const travel = Math.max(0, metrics.height - thumbHeight);
  const thumbTop = canScroll
    ? Math.max(0, Math.min(travel, (metrics.top / range) * travel))
    : 0;

  function moveThumb(clientY: number, offset: number) {
    const element = list.current;
    const bar = track.current;
    if (!element || !bar || travel <= 0) return;
    const position = Math.max(
      0,
      Math.min(travel, clientY - bar.getBoundingClientRect().top - offset),
    );
    element.scrollTop = (position / travel) * range;
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !canScroll || travel <= 0) return;
    event.preventDefault();
    const onThumb = (event.target as HTMLElement).closest(
      ".sidebar-favorites-scrollbar-thumb",
    );
    const offset = onThumb
      ? event.clientY -
        event.currentTarget.getBoundingClientRect().top -
        thumbTop
      : thumbHeight / 2;
    drag.current = { pointerId: event.pointerId, offset };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    if (!onThumb) moveThumb(event.clientY, offset);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const element = list.current;
    if (!element || !canScroll) return;
    const positions: Record<string, number> = {
      ArrowUp: element.scrollTop - 44,
      ArrowDown: element.scrollTop + 44,
      PageUp: element.scrollTop - metrics.height,
      PageDown: element.scrollTop + metrics.height,
      Home: 0,
      End: range,
    };
    if (!(event.key in positions)) return;
    event.preventDefault();
    element.scrollTop = positions[event.key];
  }

  return (
    <div
      ref={track}
      className="sidebar-favorites-scrollbar"
      role="scrollbar"
      aria-label="收藏版本滚动条"
      aria-controls={listId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.round(range)}
      aria-valuenow={Math.round(Math.max(0, Math.min(range, metrics.top)))}
      aria-hidden={!canScroll || undefined}
      tabIndex={canScroll ? 0 : -1}
      data-scrollable={canScroll || undefined}
      data-scrolling={scrolling || undefined}
      data-dragging={dragging || undefined}
      onPointerDown={startDrag}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId)
          moveThumb(event.clientY, drag.current.offset);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={handleKey}
    >
      <div
        className="sidebar-favorites-scrollbar-thumb"
        style={{
          height: thumbHeight,
          transform: `translateY(${thumbTop}px)`,
        }}
      />
    </div>
  );
}
