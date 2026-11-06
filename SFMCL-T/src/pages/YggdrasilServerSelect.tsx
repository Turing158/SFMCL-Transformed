import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Input, PixelIcon } from "../controls";
import { usePageActive } from "../PageActivity";
import { useSelectPopupMotion } from "../useSelectPopupMotion";

const services = [
  { name: "LittleSkin", address: "https://littleskin.cn/api/yggdrasil" },
  {
    name: "Blessing Skin",
    address: "https://skin.prinzeugen.net/api/yggdrasil",
  },
];
const canonical = (value: string) =>
  value.trim().replace(/\/+$/, "").toLowerCase();

export function YggdrasilServerSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const pageActive = usePageActive();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>();
  const listId = "yggdrasil-server-options";
  const choices = useMemo(() => {
    const query = canonical(value);
    const selected = services.some(
      (service) => canonical(service.address) === query,
    );
    const matches = services.filter(
      (service) =>
        selected ||
        `${service.name} ${service.address}`.toLowerCase().includes(query),
    );
    // A custom address remains editable and can also be committed explicitly.
    if (
      !selected &&
      /^(?:https?:\/\/[^\s]+|[^\s/:]+\.[^\s/]+(?:\/[^\s]*)?)$/i.test(
        value.trim(),
      )
    ) {
      return [...matches, { name: "使用自定义地址", address: value.trim() }];
    }
    return matches;
  }, [value]);
  const shown = open && pageActive && !disabled;
  const show = () => {
    if (disabled || !pageActive) return;
    if (!present) setPosition(undefined);
    setPresent(true);
    setOpen(true);
  };
  const choose = (index: number) => {
    const choice = choices[index];
    if (!choice || disabled) return;
    onChange(choice.address);
    setOpen(false);
    input.current?.focus();
  };

  useLayoutEffect(() => {
    if (!pageActive || disabled) setOpen(false);
    if (!pageActive) setPresent(false);
  }, [pageActive, disabled]);

  useLayoutEffect(() => {
    if (!present || !anchor.current || !popup.current) return;
    const field = anchor.current;
    const panel = popup.current;
    if ("showPopover" in panel) panel.showPopover();
    const positionMenu = () => {
      const rect = field.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      const below = top + height - rect.bottom - 12;
      const above = rect.top - top - 12;
      const menuWidth = Math.min(rect.width, width - 24);
      panel.style.width = `${menuWidth}px`;
      const ideal = Math.min(260, (list.current?.scrollHeight ?? 44) + 12);
      const upward = below < ideal && above > below;
      const menuHeight = Math.min(ideal, Math.max(44, upward ? above : below));
      setPosition({
        left: Math.max(
          left + 12,
          Math.min(rect.left, left + width - menuWidth - 12),
        ),
        top: upward
          ? Math.max(top + 12, rect.top - menuHeight - 6)
          : rect.bottom + 6,
        width: menuWidth,
        maxHeight: menuHeight,
        "--select-list-height": `${menuHeight - 12}px`,
        "--select-collapsed-clip": upward
          ? "inset(100% -8px 0 -8px)"
          : "inset(0 -8px 100% -8px)",
        "--select-offset": upward ? "6px" : "-6px",
      } as CSSProperties);
    };
    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(field);
    const outside = (event: PointerEvent) => {
      if (
        !field.contains(event.target as Node) &&
        !panel.contains(event.target as Node)
      )
        setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) positionMenu();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", positionMenu);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", positionMenu);
      if ("hidePopover" in panel && panel.matches(":popover-open"))
        panel.hidePopover();
    };
  }, [present, choices.length]);

  useSelectPopupMotion(popup, shown, present, !!position, setPresent);

  useLayoutEffect(() => {
    if (shown && active >= 0)
      list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, shown, choices]);

  return (
    <div ref={anchor} className="players-server-select">
      <Input
        ref={input}
        id="yggdrasil-server"
        className="pixel-select-trigger"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={
          shown && choices[active] ? `${listId}-${active}` : undefined
        }
        autoFocus
        required
        value={value}
        disabled={disabled}
        placeholder="搜索预选服务或输入自定义地址"
        autoComplete="off"
        spellCheck={false}
        onClick={() => {
          show();
          setActive(-1);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setActive(0);
          show();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
            if (choices.length)
              setActive(
                !shown || active < 0
                  ? event.key === "ArrowDown"
                    ? 0
                    : choices.length - 1
                  : (active +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      choices.length) %
                      choices.length,
              );
          } else if (event.key === "Enter" && shown) {
            event.preventDefault();
            if (choices[active]) choose(active);
            else setOpen(false);
          } else if (event.key === "Escape" && shown) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        className="players-server-toggle"
        aria-label="显示预选验证服务"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          input.current?.focus();
          setActive(-1);
          if (shown) setOpen(false);
          else show();
        }}
      >
        <PixelIcon name="chevron" />
      </button>
      {present &&
        createPortal(
          <div
            ref={popup}
            popover={
              "showPopover" in HTMLElement.prototype ? "manual" : undefined
            }
            className="pixel-select-popup pixel-surface players-server-popup"
            data-state={shown ? "open" : "closed"}
            aria-hidden={!shown || undefined}
            inert={!shown}
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
          >
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label="预选验证服务"
              className="pixel-select-list"
            >
              {choices.length ? (
                choices.map((choice, index) => (
                  <div
                    key={choice.address}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={
                      canonical(value) === canonical(choice.address)
                    }
                    className={`pixel-select-option pixel-surface ${index === active ? "is-active" : ""}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => setActive(index)}
                    onClick={() => choose(index)}
                  >
                    <span className="pixel-option-marker" aria-hidden="true" />
                    <span className="pixel-option-label">
                      {choice.name}
                      <small>{choice.address}</small>
                    </span>
                    <span className="pixel-option-check">
                      {canonical(value) === canonical(choice.address) && (
                        <PixelIcon name="check" />
                      )}
                    </span>
                  </div>
                ))
              ) : (
                <div className="pixel-select-empty">未找到预选服务</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
