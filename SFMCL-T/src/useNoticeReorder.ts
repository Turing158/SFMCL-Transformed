import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { usePageActive } from "./PageActivity";
import type { HomeNoticeLayout } from "./types";

const motion = {
  duration: 320,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
} as const;

// Keep the real card mounted in its slot: expansion state and loaded images survive.
// Only the floating, inert visual is a snapshot; it never handles user actions.
export function useNoticeReorder(
  root: RefObject<HTMLDivElement | null>,
  keys: string[],
  layout: HomeNoticeLayout,
  onReorder?: (keys: string[]) => void,
) {
  const active = usePageActive();
  const latest = useRef({ keys, onReorder });
  latest.current = { keys, onReorder };
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const enabled = !!onReorder;
  const membership = JSON.stringify([...keys].sort());

  useLayoutEffect(() => {
    const list = root.current;
    if (!list || !enabled || !active) return;
    let pending: {
      pointer: number;
      x: number;
      y: number;
      row: HTMLDivElement;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let drag: {
      pointer: number;
      key: string;
      row: HTMLDivElement;
      ghost: HTMLDivElement;
      offsetX: number;
      offsetY: number;
      x: number;
      y: number;
      order: string[];
      scroll: HTMLElement | null;
    } | null = null;
    let frame = 0;
    let suppressClick = false;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let settling: {
      ghost: HTMLElement;
      animation: Animation;
      restore: () => void;
    } | null = null;
    const moves = new Map<HTMLElement, Animation>();
    const rows = () => Array.from(list.children) as HTMLDivElement[];
    const stopPending = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    };
    const stopSettling = () => {
      settling?.animation.cancel();
      settling?.restore();
      settling = null;
    };
    const reflow = (update: () => void) => {
      const before = new Map(
        rows().map((row) => [row, row.getBoundingClientRect()]),
      );
      moves.forEach((animation) => animation.cancel());
      moves.clear();
      flushSync(update);
      rows().forEach((row) => {
        const first = before.get(row);
        const last = row.getBoundingClientRect();
        if (!first) return;
        const x = first.left - last.left;
        const y = first.top - last.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
        const animation = row.animate(
          [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }],
          { ...motion, id: "sfmcl-t-notice-reorder" },
        );
        moves.set(row, animation);
        void animation.finished.then(
          () => {
            if (moves.get(row) === animation) moves.delete(row);
          },
          () => {},
        );
      });
    };
    const positionGhost = () => {
      if (!drag) return;
      drag.ghost.style.left = `${drag.x - drag.offsetX}px`;
      drag.ghost.style.top = `${drag.y - drag.offsetY}px`;
    };
    const findSlot = () => {
      if (!drag) return;
      // Hit-test final layout, not the animated visible frames. This prevents
      // repeated swaps when another card is still sliding out of the pointer.
      const candidates = rows().filter((row) =>
        drag!.order.includes(row.dataset.noticeKey!),
      );
      let closest: HTMLDivElement | undefined;
      let distance = Infinity;
      const listRect = list.getBoundingClientRect();
      for (const row of candidates) {
        const left = listRect.left + row.offsetLeft;
        const top = listRect.top + row.offsetTop;
        const right = left + row.offsetWidth;
        const bottom = top + row.offsetHeight;
        const dx = Math.max(left - drag.x, 0, drag.x - right);
        const dy = Math.max(top - drag.y, 0, drag.y - bottom);
        const next = dx * dx + dy * dy;
        if (next < distance) {
          distance = next;
          closest = row;
        }
      }
      const target = closest?.dataset.noticeKey;
      if (!target || target === drag.key) return;
      const from = drag.order.indexOf(drag.key);
      const to = drag.order.indexOf(target);
      const next = [...drag.order];
      next.splice(from, 1);
      next.splice(to, 0, drag.key);
      drag.order = next;
      reflow(() => setOrder(next));
    };
    const tick = () => {
      if (!drag) return;
      const scroll = drag.scroll;
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        const edge = Math.min(64, bounds.height / 4);
        const speed =
          drag.y < bounds.top + edge
            ? -Math.min(14, (bounds.top + edge - drag.y) * 0.25)
            : drag.y > bounds.bottom - edge
              ? Math.min(14, (drag.y - bounds.bottom + edge) * 0.25)
              : 0;
        if (speed) {
          const previous = scroll.scrollTop;
          scroll.scrollTop += speed;
          if (scroll.scrollTop !== previous) findSlot();
        }
      }
      positionGhost();
      frame = requestAnimationFrame(tick);
    };
    const finish = (commit: boolean, animate = true) => {
      stopPending();
      if (!drag) return;
      const ended = drag;
      drag = null;
      cancelAnimationFrame(frame);
      const update = () => {
        if (commit) latest.current.onReorder?.(ended.order);
        setOrder(null);
      };
      if (animate) reflow(update);
      else update();
      const content = ended.row.querySelector<HTMLElement>(
        ".notice-list-content",
      )!;
      const bounds = list.getBoundingClientRect();
      const target = {
        left: bounds.left + ended.row.offsetLeft + content.offsetLeft,
        top: bounds.top + ended.row.offsetTop + content.offsetTop,
      };
      delete list.dataset.noticeDragging;
      delete document.body.dataset.noticeDragging;
      if (list.hasPointerCapture(ended.pointer))
        list.releasePointerCapture(ended.pointer);
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        suppressClick = false;
      }, 0);
      const restore = () => {
        ended.row.style.removeProperty("height");
        setDraggingKey(null);
        ended.ghost.remove();
      };
      if (!animate) {
        restore();
        return;
      }
      const animation = ended.ghost.animate(
        [
          {
            left: ended.ghost.style.left,
            top: ended.ghost.style.top,
            transform: "scale(1.025)",
          },
          {
            left: `${target.left}px`,
            top: `${target.top}px`,
            transform: "scale(1)",
          },
        ],
        { ...motion, id: "sfmcl-t-notice-drop", fill: "forwards" },
      );
      const landing = { ghost: ended.ghost, animation, restore };
      settling = landing;
      void animation.finished.then(
        () => {
          if (settling !== landing) return;
          settling = null;
          restore();
          animation.cancel();
        },
        () => {},
      );
    };
    const start = () => {
      const press = pending;
      if (!press || !press.row.isConnected || !list.getClientRects().length)
        return;
      pending = null;
      const key = press.row.dataset.noticeKey!;
      const content = press.row.querySelector<HTMLElement>(
        ".notice-list-content",
      )!;
      const bounds = content.getBoundingClientRect();
      const ghost = content.cloneNode(true) as HTMLDivElement;
      ghost.classList.add("notice-drag-overlay");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost
        .querySelectorAll("[id]")
        .forEach((node) => node.removeAttribute("id"));
      ghost.style.width = `${bounds.width}px`;
      ghost.style.height = `${bounds.height}px`;
      document.body.append(ghost);
      let scroll = list.parentElement;
      while (
        scroll &&
        !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)
      )
        scroll = scroll.parentElement;
      drag = {
        pointer: press.pointer,
        key,
        row: press.row,
        ghost,
        offsetX: press.x - bounds.left,
        offsetY: press.y - bounds.top,
        x: press.x,
        y: press.y,
        order: [...latest.current.keys],
        scroll,
      };
      press.row.style.height = `${press.row.offsetHeight}px`;
      suppressClick = true;
      flushSync(() => {
        setDraggingKey(key);
        setOrder(drag!.order);
      });
      list.dataset.noticeDragging = key;
      document.body.dataset.noticeDragging = "true";
      // Capture on the stationary list, since moving a row in the DOM releases
      // that row's pointer capture in Chromium/WebView2.
      list.setPointerCapture(press.pointer);
      window.getSelection()?.removeAllRanges();
      positionGhost();
      ghost.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.025)" }],
        { ...motion, duration: 180, id: "sfmcl-t-notice-lift" },
      );
      frame = requestAnimationFrame(tick);
    };
    const down = (event: PointerEvent) => {
      if (drag) {
        if (event.pointerId !== drag.pointer) finish(false);
        return;
      }
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Element)
      )
        return;
      const control = event.target.closest(
        "button, a, input, textarea, select, [contenteditable], [role='button']",
      );
      if (control && !control.matches(".notice-toggle")) return;
      const row = event.target.closest<HTMLDivElement>(".notice-list-item");
      if (
        !row ||
        row.parentElement !== list ||
        row.dataset.noticePhase !== "stable" ||
        !latest.current.keys.includes(row.dataset.noticeKey!)
      )
        return;
      stopSettling();
      stopPending();
      pending = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        row,
        timer: setTimeout(start, 420),
      };
    };
    const move = (event: PointerEvent) => {
      if (
        pending &&
        event.pointerId === pending.pointer &&
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8
      )
        stopPending();
      if (!drag || event.pointerId !== drag.pointer) return;
      event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      positionGhost();
      findSlot();
    };
    const up = (event: PointerEvent) => {
      if (pending?.pointer === event.pointerId) stopPending();
      if (drag?.pointer !== event.pointerId) return;
      event.preventDefault();
      finish(true);
    };
    const cancel = () => finish(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!pending && !drag)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const click = (event: MouseEvent) => {
      if (
        !suppressClick ||
        !(event.target instanceof Node) ||
        !list.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const context = (event: Event) => {
      if (pending || drag) event.preventDefault();
    };
    list.addEventListener("pointerdown", down);
    list.addEventListener("contextmenu", context);
    list.addEventListener("dragstart", context);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    list.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("click", click, true);
    return () => {
      finish(false, false);
      stopSettling();
      setDraggingKey(null);
      setOrder(null);
      rows().forEach((row) => row.style.removeProperty("height"));
      moves.forEach((animation) => animation.cancel());
      clearTimeout(clickTimer);
      list.removeEventListener("pointerdown", down);
      list.removeEventListener("contextmenu", context);
      list.removeEventListener("dragstart", context);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      list.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("click", click, true);
    };
  }, [root, enabled, active, layout, membership]);

  return { order, draggingKey };
}
