const opacityProperty = "--scrollbar-opacity";
const excluded =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .pixel-select-popup, .pixel-select-list, .sidebar-favorites';

type ScrollbarState = {
  hovered: boolean;
  scrolling: boolean;
  dragging: boolean;
  visible: boolean;
  idle?: number;
  animation?: Animation;
};

function canScroll(element: HTMLElement) {
  if (element.closest(excluded)) return false;
  const style = getComputedStyle(element);
  return (
    (/^(auto|scroll)$/.test(style.overflowY) &&
      element.scrollHeight > element.clientHeight + 1) ||
    (/^(auto|scroll)$/.test(style.overflowX) &&
      element.scrollWidth > element.clientWidth + 1)
  );
}

export function initializeScrollbars() {
  const states = new Map<HTMLElement, ScrollbarState>();
  let hovered = new Set<HTMLElement>();
  let dragging: HTMLElement | undefined;
  let pointer: { x: number; y: number } | undefined;
  let frame: number | undefined;

  function stateFor(element: HTMLElement) {
    let state = states.get(element);
    if (!state) {
      state = {
        hovered: false,
        scrolling: false,
        dragging: false,
        visible: false,
      };
      states.set(element, state);
    }
    return state;
  }

  function release(element: HTMLElement, state: ScrollbarState) {
    state.animation?.cancel();
    window.clearTimeout(state.idle);
    element.style.removeProperty(opacityProperty);
    states.delete(element);
  }

  function update(element: HTMLElement, state: ScrollbarState) {
    const visible = state.hovered || state.scrolling || state.dragging;
    if (visible === state.visible) return;
    state.visible = visible;
    // Sample before cancelling so reversing a fade never flashes or jumps.
    const current = getComputedStyle(element).getPropertyValue(opacityProperty);
    state.animation?.cancel();
    element.style.setProperty(opacityProperty, visible ? "1" : "0");
    const animation = element.animate(
      [
        { [opacityProperty]: current },
        { [opacityProperty]: visible ? "1" : "0" },
      ],
      { id: "sfmcl-t-scrollbar", duration: 220, easing: "ease" },
    );
    state.animation = animation;
    animation.onfinish = () => {
      if (state.animation !== animation) return;
      state.animation = undefined;
      animation.cancel();
      if (!state.visible) release(element, state);
    };
  }

  function updateHovered(target: EventTarget | null) {
    const next = new Set<HTMLElement>();
    for (
      let element = target instanceof Element ? target : null;
      element;
      element = element.parentElement
    ) {
      if (element instanceof HTMLElement && canScroll(element))
        next.add(element);
    }
    for (const element of hovered) {
      if (next.has(element)) continue;
      const state = states.get(element);
      if (state) {
        state.hovered = false;
        update(element, state);
      }
    }
    for (const element of next) {
      const state = stateFor(element);
      state.hovered = true;
      update(element, state);
    }
    hovered = next;
  }

  function refreshHovered() {
    frame = undefined;
    for (const [element, state] of states) {
      if (!element.isConnected) release(element, state);
    }
    if (pointer) updateHovered(document.elementFromPoint(pointer.x, pointer.y));
  }

  function scheduleHover() {
    if (frame === undefined) frame = requestAnimationFrame(refreshHovered);
  }

  function pointerMove(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    scheduleHover();
  }

  function pointerOut(event: PointerEvent) {
    if (event.relatedTarget !== null) return;
    pointer = undefined;
    updateHovered(null);
  }

  function activity(element: HTMLElement) {
    const state = stateFor(element);
    state.scrolling = true;
    window.clearTimeout(state.idle);
    update(element, state);
    state.idle = window.setTimeout(() => {
      state.scrolling = false;
      update(element, state);
    }, 900);
  }

  function scroll(event: Event) {
    const element =
      event.target === document ? document.scrollingElement : event.target;
    if (element instanceof HTMLElement && canScroll(element)) activity(element);
  }

  function wheel(event: WheelEvent) {
    for (
      let element = event.target instanceof Element ? event.target : null;
      element;
      element = element.parentElement
    ) {
      if (element instanceof HTMLElement && canScroll(element)) {
        activity(element);
        return;
      }
    }
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 || !(event.target instanceof HTMLElement)) return;
    const element = event.target;
    if (!canScroll(element)) return;
    const rect = element.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * element.offsetWidth) / rect.width;
    const y = ((event.clientY - rect.top) * element.offsetHeight) / rect.height;
    const style = getComputedStyle(element);
    // Native tracks are outside the client box; content clicks never start a drag.
    const onVerticalTrack =
      (x >= element.clientLeft + element.clientWidth &&
        x < element.offsetWidth - parseFloat(style.borderRightWidth)) ||
      (x >= parseFloat(style.borderLeftWidth) && x < element.clientLeft);
    const onHorizontalTrack =
      y >= element.clientTop + element.clientHeight &&
      y < element.offsetHeight - parseFloat(style.borderBottomWidth);
    if (!onVerticalTrack && !onHorizontalTrack) return;
    dragging = element;
    const state = stateFor(element);
    state.dragging = true;
    update(element, state);
  }

  function pointerUp(event: PointerEvent) {
    if (dragging) {
      const state = states.get(dragging);
      if (state) {
        state.dragging = false;
        update(dragging, state);
      }
      dragging = undefined;
    }
    pointerMove(event);
  }

  function leaveWindow() {
    pointer = undefined;
    updateHovered(null);
    if (dragging) {
      const state = states.get(dragging);
      if (state) {
        state.dragging = false;
        update(dragging, state);
      }
      dragging = undefined;
    }
  }

  document.addEventListener("pointerover", pointerMove, { passive: true });
  document.addEventListener("pointermove", pointerMove, { passive: true });
  document.addEventListener("pointerout", pointerOut, { passive: true });
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("pointerup", pointerUp, true);
  document.addEventListener("pointercancel", pointerUp, true);
  document.addEventListener("scroll", scroll, { capture: true, passive: true });
  document.addEventListener("wheel", wheel, { capture: true, passive: true });
  window.addEventListener("blur", leaveWindow);
  window.addEventListener("resize", scheduleHover);
  // New cards, popovers and retained pages can change the scrollport under a
  // stationary pointer. Batch those changes without scanning the whole tree.
  const observer = new MutationObserver(scheduleHover);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "open", "style"],
  });

  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    document.removeEventListener("pointerover", pointerMove);
    document.removeEventListener("pointermove", pointerMove);
    document.removeEventListener("pointerout", pointerOut);
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("pointerup", pointerUp, true);
    document.removeEventListener("pointercancel", pointerUp, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("wheel", wheel, true);
    window.removeEventListener("blur", leaveWindow);
    window.removeEventListener("resize", scheduleHover);
    for (const [element, state] of states) release(element, state);
  };
}
