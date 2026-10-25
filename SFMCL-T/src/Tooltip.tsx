import { useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

// Measure the untransformed box so an interrupted transition never shifts its anchor.
export function positionTooltip(
  anchor: HTMLElement,
  panel: HTMLDivElement,
  { width = 320, height = 320, preferred = "top", align = "center" } = {},
) {
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft ?? 0;
  const y = viewport?.offsetTop ?? 0;
  const vw = viewport?.width ?? innerWidth;
  const vh = viewport?.height ?? innerHeight;
  const margin = 12;
  const gap = 10;
  if (
    !anchor.isConnected ||
    anchor.closest('[hidden], [inert], [aria-hidden="true"]') ||
    !anchor.getClientRects().length ||
    rect.bottom < y + margin ||
    rect.top > y + vh - margin ||
    rect.right < x + margin ||
    rect.left > x + vw - margin
  )
    return false;
  panel.style.maxWidth = `${Math.max(0, Math.min(width, vw - margin * 2))}px`;
  panel.style.maxHeight = `${Math.max(0, Math.min(height, vh - margin * 2))}px`;
  if (preferred === "right") {
    const left = rect.right + gap;
    const availableWidth = x + vw - margin - left;
    if (availableWidth <= 0) return false;
    panel.style.maxWidth = `${Math.min(width, availableWidth)}px`;
    const center = rect.top + rect.height / 2;
    const top = Math.max(
      y + margin,
      Math.min(
        center - panel.offsetHeight / 2,
        y + vh - panel.offsetHeight - margin,
      ),
    );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.dataset.placement = "right";
    // A rotated 8px arrow needs 6px above and below its center.
    const arrowInset = 6;
    panel.style.setProperty(
      "--tooltip-tail-y",
      `${Math.max(arrowInset, Math.min(center - top - panel.clientTop, panel.clientHeight - arrowInset))}px`,
    );
    return true;
  }
  const above = rect.top - y - margin - gap;
  const below = y + vh - margin - rect.bottom - gap;
  const upward =
    preferred === "top"
      ? above >= panel.offsetHeight || above >= below
      : below < panel.offsetHeight && above > below;
  panel.style.maxHeight = `${Math.max(0, Math.min(height, upward ? above : below))}px`;
  const left = Math.max(
    x + margin,
    Math.min(
      align === "start"
        ? rect.left
        : rect.left + rect.width / 2 - panel.offsetWidth / 2,
      x + vw - panel.offsetWidth - margin,
    ),
  );
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(y + margin, upward ? rect.top - panel.offsetHeight - gap : rect.bottom + gap)}px`;
  panel.dataset.placement = upward ? "top" : "bottom";
  panel.style.setProperty(
    "--tooltip-tail-x",
    `${Math.max(
      10,
      Math.min(rect.left + rect.width / 2 - left, panel.offsetWidth - 10),
    )}px`,
  );
  return true;
}

export function useTooltipMotion(
  open: boolean,
  popup: RefObject<HTMLDivElement | null>,
) {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) setPresent(true);
    const panel = popup.current;
    if (!panel) return;
    panel.getBoundingClientRect();
    panel.dataset.open = String(open);
    if (open) return;
    let cancelled = false;
    void Promise.allSettled(
      panel.getAnimations().map((animation) => animation.finished),
    ).then(() => {
      if (!cancelled) setPresent(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, present, popup]);
  return open || present;
}

export function TooltipHost() {
  useEffect(() => {
    const id = "sfmcl-t-tooltip";
    const panel = document.createElement("div");
    panel.id = id;
    panel.className = "sfmcl-t-tooltip";
    panel.popover = "manual";
    const body = document.createElement("div");
    body.className = "sfmcl-t-tooltip-body";
    panel.append(body);
    let active: HTMLElement | null = null;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let suppressed: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let overPanel = false;
    let revision = 0;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let skipDelayUntil = 0;
    let currentContent = "";
    let dismissalPoint: { x: number; y: number } | null = null;
    let pointerPoint = { x: 0, y: 0 };
    const retiring = new Set<HTMLDivElement>();
    const trigger = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>("[data-tooltip]")
        : null;
    const content = (element: HTMLElement) =>
      element.dataset.tooltip?.trim() ?? "";
    const placement = (element: HTMLElement) =>
      element.dataset.tooltipPlacement === "right"
        ? "right"
        : element.dataset.tooltipPlacement === "bottom"
          ? "bottom"
          : "top";
    const describe = (element: HTMLElement, visible: boolean) => {
      const ids = new Set(
        (element.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean),
      );
      if (visible) ids.add(id);
      else ids.delete(id);
      if (ids.size)
        element.setAttribute("aria-describedby", [...ids].join(" "));
      else element.removeAttribute("aria-describedby");
    };
    const cancelTimers = () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      pending = null;
    };
    const hide = () => {
      cancelTimers();
      if (!active) return;
      describe(active, false);
      panel.dataset.open = "false";
      panel.setAttribute("aria-hidden", "true");
      const currentRevision = ++revision;
      skipDelayUntil = Date.now() + 300;
      void Promise.allSettled(
        panel.getAnimations().map((animation) => animation.finished),
      ).then(() => {
        if (currentRevision !== revision) return;
        panel.remove();
        active = null;
      });
    };
    const position = () => {
      if (
        active &&
        (active.getAttribute("aria-expanded") === "true" ||
          !positionTooltip(active, panel, {
            preferred: placement(active),
          }))
      )
        hide();
    };
    const resize = new ResizeObserver(position);
    const retire = () => {
      if (!panel.isConnected) return;
      const style = getComputedStyle(panel);
      const old = panel.cloneNode(true) as HTMLDivElement;
      old.removeAttribute("id");
      old.removeAttribute("role");
      old.setAttribute("aria-hidden", "true");
      old.style.transition = "none";
      old.style.opacity = style.opacity;
      old.style.transform = style.transform;
      (panel.parentElement ?? document.body).append(old);
      old.showPopover();
      retiring.add(old);
      old.getBoundingClientRect();
      old.dataset.open = "false";
      old.style.removeProperty("transition");
      old.style.removeProperty("opacity");
      old.style.removeProperty("transform");
      void Promise.allSettled(
        old.getAnimations().map((animation) => animation.finished),
      ).then(() => {
        old.remove();
        retiring.delete(old);
      });
    };
    const show = (element: HTMLElement) => {
      cancelTimers();
      if (
        element === suppressed ||
        !content(element) ||
        element.getAttribute("aria-expanded") === "true"
      )
        return;
      ++revision;
      if (active !== element) {
        retire();
        if (active) describe(active, false);
        panel.remove();
        panel.dataset.open = "false";
        active = element;
      }
      // Text nodes keep filenames, paths and server-provided labels inert.
      body.replaceChildren();
      currentContent = content(element);
      const match = content(element).match(
        /^(.*?)\s*·\s*((?:(?:Ctrl|Alt|Shift|Meta)\s*\+\s*)*\S+|Esc|Enter|Delete)$/,
      );
      if (
        match &&
        /^(?:(?:Ctrl|Alt|Shift|Meta)\s*\+|Esc$|Enter$|Delete$)/.test(match[2])
      ) {
        const line = document.createElement("span");
        line.className = "sfmcl-t-tooltip-line";
        const key = document.createElement("kbd");
        key.textContent = match[2];
        line.append(document.createTextNode(match[1]), key);
        body.append(line);
      } else body.textContent = content(element);
      panel.setAttribute("role", "tooltip");
      panel.setAttribute("aria-hidden", "false");
      const container = element.closest("dialog[open]") ?? document.body;
      if (panel.parentElement !== container) container.append(panel);
      if (!panel.matches(":popover-open")) panel.showPopover();
      if (
        !positionTooltip(element, panel, {
          preferred: placement(element),
        })
      ) {
        hide();
        return;
      }
      panel.getBoundingClientRect();
      panel.dataset.open = "true";
      describe(element, true);
      resize.disconnect();
      resize.observe(element);
      resize.observe(panel);
    };
    const schedule = (element: HTMLElement, immediate = false) => {
      cancelTimers();
      if (suppressed === element) return;
      pending = element;
      if (
        immediate ||
        active === element ||
        panel.dataset.open === "true" ||
        Date.now() < skipDelayUntil
      )
        show(element);
      else openTimer = setTimeout(() => show(element), 350);
    };
    const leave = () => {
      clearTimeout(openTimer);
      pending = null;
      if (overPanel || (active && (hovered === active || focused === active)))
        return;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(hide, 130);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointerPoint = { x: event.clientX, y: event.clientY };
      if (panel.contains(event.target as Node)) {
        overPanel = true;
        clearTimeout(closeTimer);
        return;
      }
      const next = trigger(event.target);
      // Removing a hovered popup can expose another trigger without moving the pointer.
      if (
        dismissalPoint &&
        Math.abs(event.clientX - dismissalPoint.x) < 1 &&
        Math.abs(event.clientY - dismissalPoint.y) < 1
      ) {
        hovered = next;
        return;
      }
      dismissalPoint = null;
      if (
        next === hovered &&
        (next === null ||
          pending === next ||
          (active === next && panel.dataset.open === "true"))
      )
        return;
      hovered = next;
      if (suppressed !== next) suppressed = null;
      if (next) schedule(next);
      else leave();
    };
    const out = (event: PointerEvent) => {
      if (
        panel.contains(event.target as Node) &&
        !panel.contains(event.relatedTarget as Node)
      )
        overPanel = false;
      const next = trigger(event.relatedTarget);
      if (next !== hovered) {
        hovered = next;
        if (suppressed !== next) suppressed = null;
      }
      leave();
    };
    const focus = (event: FocusEvent) => {
      const next = trigger(event.target);
      focused =
        event.target instanceof Element &&
        event.target.matches(":focus-visible")
          ? next
          : null;
      if (focused) {
        suppressed = null;
        schedule(focused, true);
      }
    };
    const blur = () => {
      focused = null;
      leave();
    };
    const dismiss = (event: Event) => {
      if (panel.contains(event.target as Node)) return;
      suppressed = active ?? pending;
      hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panel.dataset.open === "true") event.preventDefault();
        if (overPanel) dismissalPoint = pointerPoint;
        dismiss(event);
      }
    };
    const scroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) position();
    };
    // React can replace a hovered row, change a live status, or hide a retained page.
    const changes = new MutationObserver(() => {
      if (!active) return;
      if (panel.dataset.open === "true" && content(active) !== currentContent) {
        if (content(active)) show(active);
        else hide();
      }
      position();
    });
    changes.observe(document.getElementById("root")!, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-tooltip",
        "data-tooltip-placement",
        "hidden",
        "inert",
        "aria-hidden",
        "aria-expanded",
      ],
    });
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", position);
    window.addEventListener("blur", hide);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelTimers();
      ++revision;
      if (active) describe(active, false);
      panel.remove();
      retiring.forEach((old) => old.remove());
      resize.disconnect();
      changes.disconnect();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("blur", hide);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, []);
  return null;
}
