import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { PixelMenuIcon } from "./PixelMenuIcon";
import "./context-menu.css";

export type ContextMenuItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  hasPopup?: "dialog";
  onSelect?: () => void;
  children?: ContextMenuEntry[];
};
export type ContextMenuEntry = ContextMenuItem | { separator: true };
export type ContextMenuAnchor = { x: number; y: number; element: HTMLElement };

const buttons = (panel: HTMLElement | null) =>
  panel
    ? [
        ...panel.querySelectorAll<HTMLButtonElement>(
          ".pixel-context-item:not(:disabled)",
        ),
      ]
    : [];

export function ContextMenu({
  anchor,
  title,
  description,
  showHeading = true,
  className = "",
  items,
  onClose,
}: {
  anchor: ContextMenuAnchor;
  title: string;
  description?: string;
  showHeading?: boolean;
  className?: string;
  items: ContextMenuEntry[];
  onClose: () => void;
}) {
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const child = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [compact, setCompact] = useState(false);
  const focusChild = useRef(false);
  const focusParent = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const subTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const parentItem = items.find(
    (item): item is ContextMenuItem =>
      !("separator" in item) && item.id === submenu,
  );
  const latest = useRef({ anchor, onClose });
  latest.current = { anchor, onClose };

  function close(restore = true, immediate = false) {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTimeout(subTimer.current);
    if (restore && latest.current.anchor.element.isConnected)
      latest.current.anchor.element.focus({ preventScroll: true });
    if (immediate) {
      latest.current.onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => latest.current.onClose(), 170);
  }
  function closeSub(restore = false) {
    clearTimeout(subTimer.current);
    if (restore)
      focusParent.current =
        root.current?.querySelector<HTMLButtonElement>(
          '[aria-expanded="true"]',
        ) ?? null;
    setSubmenu(null);
  }
  function openSub(item: ContextMenuItem, keyboard: boolean) {
    if (!item.children || item.disabled) return;
    clearTimeout(subTimer.current);
    if (submenu === item.id) {
      if (keyboard) buttons(child.current)[0]?.focus({ preventScroll: true });
      return;
    }
    focusChild.current = keyboard;
    setSubmenu(item.id);
  }
  function position() {
    const panel = root.current;
    if (!panel) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth,
      height = viewport?.height ?? innerHeight;
    const margin = 12;
    panel.style.maxWidth = `${width - margin * 2}px`;
    panel.style.maxHeight = `${height - margin * 2}px`;
    const x = Math.max(
      left + margin,
      Math.min(anchor.x, left + width - panel.offsetWidth - margin),
    );
    const y = Math.max(
      top + margin,
      Math.min(anchor.y, top + height - panel.offsetHeight - margin),
    );
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
    const nested = child.current;
    const trigger = panel.querySelector<HTMLElement>('[aria-expanded="true"]');
    if (!nested || !trigger) return;
    nested.style.maxHeight = `${height - margin * 2}px`;
    const rect = trigger.getBoundingClientRect();
    const isCompact = width < panel.offsetWidth + 208 + 36;
    setCompact(isCompact);
    if (isCompact) {
      nested.style.width = `${panel.offsetWidth}px`;
      nested.style.left = panel.style.left;
      nested.style.top = `${Math.round(Math.min(y, top + height - nested.offsetHeight - margin))}px`;
    } else {
      nested.style.removeProperty("width");
      let subX = x + panel.offsetWidth + 7;
      if (subX + nested.offsetWidth > left + width - margin)
        subX = x - nested.offsetWidth - 7;
      nested.style.left = `${Math.round(Math.max(left + margin, subX))}px`;
      nested.style.top = `${Math.round(Math.max(top + margin, Math.min(rect.top - 6, top + height - nested.offsetHeight - margin)))}px`;
    }
  }
  useLayoutEffect(() => {
    layer.current?.showPopover();
    position();
    buttons(root.current)[0]?.focus({ preventScroll: true });
    return () => layer.current?.hidePopover();
  }, []);
  useLayoutEffect(() => {
    position();
    if (!submenu && focusParent.current) {
      focusParent.current.focus({ preventScroll: true });
      focusParent.current = null;
    }
    if (focusChild.current) {
      buttons(child.current)[0]?.focus({ preventScroll: true });
      focusChild.current = false;
    }
  }, [submenu, compact, items, anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!layer.current?.contains(event.target as Node)) close(false);
    };
    const scroll = (event: Event) => {
      if (!layer.current?.contains(event.target as Node)) close(false);
    };
    const blur = () => close(false);
    const focus = (event: FocusEvent) => {
      if (
        !layer.current?.contains(event.target as Node) &&
        event.target !== latest.current.anchor.element
      )
        close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focus);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", position);
    window.addEventListener("blur", blur);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      clearTimeout(closeTimer.current);
      clearTimeout(subTimer.current);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("blur", blur);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [anchor]);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const panel = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="menu"]',
    );
    if (!panel) return;
    const choices = buttons(panel),
      index = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (panel === root.current) closeSub();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? choices.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % choices.length
              : (index <= 0 ? choices.length : index) - 1;
      choices[next]?.focus({ preventScroll: true });
    } else if (event.key === "ArrowRight" && panel === root.current) {
      const item = items.find(
        (entry): entry is ContextMenuItem =>
          !("separator" in entry) &&
          entry.id === (event.target as HTMLElement).dataset.menuId,
      );
      if (item?.children) {
        event.preventDefault();
        openSub(item, true);
      }
    } else if (event.key === "ArrowLeft" && panel === child.current) {
      event.preventDefault();
      closeSub(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (submenu) closeSub(true);
      else close();
    } else if (event.key === "Tab") {
      close(true, true);
    }
  }
  function rows(entries: ContextMenuEntry[], nested = false) {
    return entries.map((entry, index) =>
      "separator" in entry ? (
        <div
          key={`separator-${index}`}
          role="separator"
          className="pixel-context-separator"
        />
      ) : (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className={`pixel-context-item${entry.danger ? " danger" : ""}`}
          data-menu-id={entry.id}
          disabled={entry.disabled}
          tabIndex={-1}
          style={{ "--menu-order": index } as CSSProperties}
          aria-haspopup={entry.children ? "menu" : entry.hasPopup}
          aria-expanded={entry.children ? submenu === entry.id : undefined}
          aria-controls={
            entry.children && submenu === entry.id ? `${id}-submenu` : undefined
          }
          onPointerEnter={(event) => {
            clearTimeout(subTimer.current);
            if (
              !nested &&
              entry.children &&
              innerWidth >= 580 &&
              event.pointerType !== "touch"
            )
              openSub(entry, false);
            else if (!nested) closeSub();
          }}
          onClick={() => {
            if (entry.children) openSub(entry, true);
            else {
              close(false, true);
              entry.onSelect?.();
            }
          }}
        >
          <span className="pixel-context-icon">{entry.icon}</span>
          <span className="pixel-context-label">{entry.label}</span>
          {entry.children && (
            <span className="pixel-context-arrow">
              <PixelMenuIcon name="arrow" />
            </span>
          )}
        </button>
      ),
    );
  }
  return createPortal(
    <div
      ref={layer}
      popover="manual"
      className={`pixel-context-layer${closing ? " closing" : ""}`}
      onKeyDown={keyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={root}
        role="menu"
        aria-label={`${title} 的版本操作`}
        aria-hidden={(compact && !!submenu) || undefined}
        className={`pixel-context-menu ${className}${compact && submenu ? " covered" : ""}`}
        onPointerEnter={() => clearTimeout(subTimer.current)}
        onPointerLeave={() => {
          if (innerWidth >= 580 && !compact)
            subTimer.current = setTimeout(() => closeSub(), 260);
        }}
      >
        <div className="pixel-context-frame">
          <div className="pixel-context-face">
            {showHeading && (
              <header className="pixel-context-heading">
                <span className="pixel-context-title">{title}</span>
                {description && (
                  <span className="pixel-context-description">
                    {description}
                  </span>
                )}
              </header>
            )}
            {rows(items)}
          </div>
        </div>
      </div>
      {parentItem?.children && (
        <div
          ref={child}
          id={`${id}-submenu`}
          role="menu"
          aria-label={`${title} · 更多`}
          className="pixel-context-menu pixel-context-submenu"
          onPointerEnter={() => clearTimeout(subTimer.current)}
          onPointerLeave={() => {
            if (innerWidth >= 580 && !compact)
              subTimer.current = setTimeout(() => closeSub(), 260);
          }}
        >
          <div className="pixel-context-frame">
            <div className="pixel-context-face">
              {compact && (
                <button
                  type="button"
                  role="menuitem"
                  className="pixel-context-item pixel-context-back"
                  tabIndex={-1}
                  onClick={() => closeSub(true)}
                >
                  <PixelMenuIcon name="arrow" />
                  返回
                </button>
              )}
              {rows(parentItem.children, true)}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
