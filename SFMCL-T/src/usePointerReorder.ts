import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { usePageActive } from "./PageActivity";

export interface PointerReorderOptions {
  rowSelector: string;
  keyAttribute: string;
  contentSelector?: string;
  allowedControl: string;
  overlayClass: string;
  draggingAttribute: string;
  animationPrefix: string;
  holdOnly?: boolean;
  ready?: (row: HTMLElement) => boolean;
  acceptTarget?: (target: Element, row: HTMLElement) => boolean;
  overlayParent?: (list: HTMLElement) => HTMLElement;
}

const motion = {
  duration: 320,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
} as const;

// Keep the real card mounted in its slot: expansion state and loaded images survive.
// Only the floating, inert visual is a snapshot; it never handles user actions.
export function usePointerReorder(
  root: RefObject<HTMLDivElement | null>,
  keys: string[],
  layout: string,
  options: PointerReorderOptions,
  onReorder?: (keys: string[]) => void,
) {
  const active = usePageActive();
  const latest = useRef({ keys, onReorder });
  latest.current = { keys, onReorder };
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const enabled = !!onReorder;
  const membership = JSON.stringify([...keys].sort());
  const cancelDrag = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const list = root.current;
    if (!list || !enabled || !active) return;
    let pending: {
      pointer: number;
      x: number;
      y: number;
      row: HTMLDivElement;
      hold: boolean;
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
    const rows = () =>
      Array.from(list.children).filter((row) =>
        row.matches(options.rowSelector),
      ) as HTMLDivElement[];
    const keyOf = (row: HTMLElement) => row.getAttribute(options.keyAttribute)!;
    const contentOf = (row: HTMLElement) =>
      options.contentSelector
        ? row.querySelector<HTMLElement>(options.contentSelector)!
        : row;
    const layoutRect = (row: HTMLElement) => {
      const rect = list.getBoundingClientRect();
      const parent = row.offsetParent;
      const base =
        parent instanceof HTMLElement && parent !== list
          ? parent.getBoundingClientRect()
          : rect;
      return {
        left: base.left + row.offsetLeft + list.clientLeft - list.scrollLeft,
        top: base.top + row.offsetTop + list.clientTop - list.scrollTop,
      };
    };
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
          { ...motion, id: `${options.animationPrefix}-reorder` },
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
        drag!.order.includes(keyOf(row)),
      );
      let closest: HTMLDivElement | undefined;
      let distance = Infinity;
      for (const row of candidates) {
        const { left, top } = layoutRect(row);
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
      const target = closest && keyOf(closest);
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
        if (
          commit &&
          ended.order.some((key, index) => key !== latest.current.keys[index])
        )
          latest.current.onReorder?.(ended.order);
        setOrder(null);
      };
      if (animate) reflow(update);
      else update();
      const content = contentOf(ended.row);
      const bounds = layoutRect(ended.row);
      const target = {
        left: bounds.left + (content === ended.row ? 0 : content.offsetLeft),
        top: bounds.top + (content === ended.row ? 0 : content.offsetTop),
      };
      list.removeAttribute(options.draggingAttribute);
      document.body.removeAttribute(options.draggingAttribute);
      if (list.hasPointerCapture(ended.pointer))
        list.releasePointerCapture(ended.pointer);
      clearTimeout(clickTimer);
      if (commit)
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
        { ...motion, id: `${options.animationPrefix}-drop`, fill: "forwards" },
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
      clearTimeout(press.timer);
      pending = null;
      const key = keyOf(press.row);
      const content = contentOf(press.row);
      const bounds = content.getBoundingClientRect();
      const ghost = content.cloneNode(true) as HTMLDivElement;
      ghost.classList.add(options.overlayClass);
      ghost.style.viewTransitionName = "none";
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost
        .querySelectorAll("[id]")
        .forEach((node) => node.removeAttribute("id"));
      ghost.removeAttribute("id");
      const canvases = content.querySelectorAll("canvas");
      ghost.querySelectorAll("canvas").forEach((canvas, index) => {
        canvas.getContext("2d")?.drawImage(canvases[index], 0, 0);
      });
      ghost.style.width = `${bounds.width}px`;
      ghost.style.height = `${bounds.height}px`;
      (options.overlayParent?.(list) ?? document.body).append(ghost);
      let scroll: HTMLElement | null = list;
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
      list.setAttribute(options.draggingAttribute, key);
      document.body.setAttribute(options.draggingAttribute, "true");
      // Capture on the stationary list, since moving a row in the DOM releases
      // that row's pointer capture in Chromium/WebView2.
      list.setPointerCapture(press.pointer);
      window.getSelection()?.removeAllRanges();
      positionGhost();
      ghost.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.025)" }],
        { ...motion, duration: 180, id: `${options.animationPrefix}-lift` },
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
      suppressClick = false;
      const control = event.target.closest(
        "button, a, input, textarea, select, [contenteditable], [role='button']",
      );
      if (control && !control.matches(options.allowedControl)) return;
      const row = event.target.closest<HTMLDivElement>(options.rowSelector);
      if (
        !row ||
        row.parentElement !== list ||
        (options.ready && !options.ready(row)) ||
        (options.acceptTarget && !options.acceptTarget(event.target, row)) ||
        !latest.current.keys.includes(keyOf(row))
      )
        return;
      stopSettling();
      stopPending();
      pending = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        row,
        hold: !!options.holdOnly || event.pointerType === "touch",
        timer: setTimeout(start, 420),
      };
    };
    const move = (event: PointerEvent) => {
      if (
        pending &&
        event.pointerId === pending.pointer &&
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 8
      ) {
        if (pending.hold) stopPending();
        else start();
      }
      if (!drag || event.pointerId !== drag.pointer) return;
      event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      positionGhost();
      findSlot();
    };
    const up = (event: PointerEvent) => {
      if (pending?.pointer === event.pointerId) stopPending();
      if (drag?.pointer !== event.pointerId) {
        if (suppressClick)
          clickTimer = setTimeout(() => {
            suppressClick = false;
          }, 0);
        return;
      }
      event.preventDefault();
      finish(true);
    };
    const cancel = () => finish(false);
    cancelDrag.current = () => {
      finish(false, false);
      stopSettling();
      moves.forEach((animation) => animation.cancel());
    };
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
      cancelDrag.current = () => {};
    };
  }, [root, enabled, active, layout, membership, options]);

  return { order, draggingKey, cancel: () => cancelDrag.current() };
}
