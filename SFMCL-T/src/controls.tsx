import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePageActive } from "./PageActivity";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

function PixelIcon({ name }: { name: "check" | "chevron" | "close" }) {
  const paths = {
    check:
      "M1 6H3V8H5V10H7V8H9V6H11V4H13V2H15V5H13V7H11V9H9V11H7V13H5V11H3V9H1Z",
    chevron: "M3 6h4v3h6V6h4v5h-4v3H7v-3H3z",
    close:
      "M3 3h3v3h3v3h2V6h3V3h3v3h-3v3h-3v2h3v3h3v3h-3v-3h-3v-3H9v3H6v3H3v-3h3v-3h3V9H6V6H3z",
  };
  return (
    <svg
      className="pixel-icon"
      viewBox={name === "check" ? "0 0 16 16" : "0 0 20 20"}
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {name === "check" && (
        <path
          className="pixel-check-shadow"
          fill="var(--pixel-check-shadow)"
          transform="translate(1 1)"
          d={paths.check}
        />
      )}
      <path fill="currentColor" fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={`pixel-input pixel-surface ${className}`}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={`pixel-input pixel-textarea pixel-surface ${className}`}
    />
  );
});

export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
    indeterminate?: boolean;
  }
>(function Checkbox({ className = "", indeterminate = false, ...props }, ref) {
  const input = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      {...props}
      type="checkbox"
      className={`pixel-checkbox pixel-surface ${className}`}
      ref={(element) => {
        input.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
    />
  );
});

export function Switch({
  checked,
  onCheckedChange,
  checkedLabel,
  uncheckedLabel,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  checkedLabel?: string;
  uncheckedLabel?: string;
}) {
  const labeled = checkedLabel !== undefined || uncheckedLabel !== undefined;
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={`pixel-switch ${labeled ? "pixel-switch-labeled" : ""} ${className}`}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="pixel-switch-track pixel-surface" aria-hidden="true">
        {labeled && (
          <>
            <span className="pixel-switch-label" data-state="checked">
              {checkedLabel}
            </span>
            <span className="pixel-switch-label" data-state="unchecked">
              {uncheckedLabel}
            </span>
          </>
        )}
        <span className="pixel-switch-thumb pixel-surface" />
      </span>
    </button>
  );
}

export const Slider = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type">
>(function Slider(
  {
    className = "",
    style,
    value,
    defaultValue,
    min = 0,
    max = 100,
    disabled,
    ...props
  },
  ref,
) {
  const [uncontrolledValue, setUncontrolledValue] = useState(
    Number(defaultValue ?? (Number(min) + Number(max)) / 2),
  );
  const progress = Math.min(
    100,
    Math.max(
      0,
      ((Number(value ?? uncontrolledValue) - Number(min)) /
        (Number(max) - Number(min) || 1)) *
        100,
    ),
  );
  return (
    <span
      className={`pixel-range ${className}`}
      data-disabled={disabled || undefined}
      style={{ "--range-progress": `${progress}%` } as CSSProperties}
    >
      <span className="pixel-range-track pixel-surface" aria-hidden="true">
        <span className="pixel-range-fill" />
      </span>
      <input
        {...props}
        ref={ref}
        type="range"
        className="pixel-range-input"
        style={style}
        min={min}
        max={max}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={(event) => {
          setUncontrolledValue(Number(event.currentTarget.value));
          props.onChange?.(event);
        }}
      />
    </span>
  );
});

interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "size"
> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  resultCount?: number;
  loading?: boolean;
  submitHint?: boolean;
}

export function SearchField({
  label,
  value,
  onValueChange,
  resultCount,
  loading = false,
  submitHint = false,
  className = "",
  onKeyDown,
  disabled,
  ...props
}: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const clear = () => {
    onValueChange("");
    input.current?.focus();
  };
  return (
    <div
      className={`search-field pixel-search pixel-surface ${className}`}
      data-disabled={disabled || undefined}
    >
      <span
        className={`pixel-search-symbol pixel-surface ${loading ? "is-loading" : ""}`}
      >
        <span className="pixel-icon pixel-search-icon" aria-hidden="true" />
      </span>
      <input
        {...props}
        ref={input}
        type="search"
        className="pixel-search-input"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
          onKeyDown?.(event);
        }}
      />
      {resultCount !== undefined && (
        <span
          className="pixel-search-count"
          aria-live="polite"
          aria-atomic="true"
        >
          {resultCount} 项
        </span>
      )}
      {value ? (
        <button
          type="button"
          className="pixel-search-clear"
          aria-label={`清空${label}`}
          data-tooltip="清空搜索 · Esc"
          disabled={disabled}
          onClick={clear}
        >
          <PixelIcon name="close" />
        </button>
      ) : (
        submitHint && (
          <kbd className="pixel-search-hint" aria-hidden="true">
            Enter
          </kbd>
        )
      )}
      {loading && (
        <span className="sr-only" role="status">
          正在搜索
        </span>
      )}
    </div>
  );
}

interface Choice {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
}

function optionText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? optionText(child.props.children)
        : String(child),
    )
    .join("");
}

// Keep JSX <option> declarations at call sites, but render a fully styled listbox.
function collectChoices(
  children: ReactNode,
  group?: string,
  groupDisabled = false,
): Choice[] {
  return Children.toArray(children).flatMap((child): Choice[] => {
    if (
      !isValidElement<{
        children?: ReactNode;
        label?: string;
        value?: string | number;
        disabled?: boolean;
        hidden?: boolean;
      }>(child)
    )
      return [];
    if (child.type === Fragment)
      return collectChoices(child.props.children, group, groupDisabled);
    if (child.type === "optgroup")
      return collectChoices(
        child.props.children,
        child.props.label,
        groupDisabled || !!child.props.disabled,
      );
    if (child.type !== "option" || child.props.hidden) return [];
    const text = child.props.label ?? optionText(child.props.children).trim();
    return [
      {
        value: String(
          child.props.value ?? optionText(child.props.children).trim(),
        ),
        label: text,
        disabled: groupDisabled || !!child.props.disabled,
        group,
      },
    ];
  });
}

interface SelectProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "onClick" | "children" | "name"
> {
  "data-tooltip"?: string;
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  placeholder?: string;
  name?: string;
  displayValue?: ReactNode;
  animateValue?: boolean;
  onRemoveOption?: (value: string) => void;
  removeOptionLabel?: (value: string) => string;
  optionActionsDisabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  children,
  placeholder = "请选择",
  className = "",
  id,
  name,
  displayValue,
  animateValue = false,
  onRemoveOption,
  removeOptionLabel = (value) => `删除 ${value}`,
  optionActionsDisabled = false,
  disabled,
  onKeyDown,
  title,
  "data-tooltip": tooltip,
  ...props
}: SelectProps) {
  const pageActive = usePageActive();
  const generatedId = useId();
  const triggerId = id || `select-${generatedId}`;
  const listId = `${triggerId}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const popupMotion = useRef<Animation | null>(null);
  const [active, setActive] = useState(-1);
  const [actionActive, setActionActive] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const [menuLabel, setMenuLabel] = useState("选择选项");
  const choices = useMemo(() => collectChoices(children), [children]);
  const hasActions = !!onRemoveOption;
  const removable = (index: number) =>
    !!choices[index]?.value && !choices[index].disabled;
  const activeAction = hasActions && actionActive && removable(active);
  const activeId = `${listId}-${active}${activeAction ? "-remove" : ""}`;
  const selected = choices.findIndex((option) => option.value === value);
  const enabled = choices
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);
  const popoverSupported =
    typeof HTMLElement !== "undefined" &&
    "showPopover" in HTMLElement.prototype;

  const close = () => {
    setOpen(false);
    typeahead.current = { text: "", time: 0 };
  };
  const choose = (index: number) => {
    const option = choices[index];
    if (!option || option.disabled || disabled) return;
    onValueChange(option.value);
    close();
  };
  const remove = (index: number, keyboard = false) => {
    if (disabled || optionActionsDisabled || !removable(index)) return;
    // Pointer deletion must not pass its highlight to the row replacing it.
    setActive(keyboard ? index : -1);
    setActionActive(false);
    onRemoveOption?.(choices[index].value);
  };
  const show = () => {
    if (disabled) return;
    if (!present) setPosition(undefined);
    setActive(enabled.includes(selected) ? selected : (enabled[0] ?? -1));
    setActionActive(false);
    const label = trigger.current?.labels?.[0];
    const labelText =
      label &&
      [...label.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join("")
        .trim();
    setMenuLabel(props["aria-label"] || labelText || "选择选项");
    setPresent(true);
    setOpen(true);
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!pageActive) {
      setOpen(false);
      setPresent(false);
    }
  }, [pageActive]);
  useEffect(() => {
    if (open && active >= 0 && (!choices[active] || choices[active].disabled))
      setActive(enabled[0] ?? -1);
  }, [choices, active, open, enabled]);

  useLayoutEffect(() => {
    if (!present || !trigger.current || !popup.current) return;
    const anchor = trigger.current;
    const panel = popup.current;
    if (popoverSupported) panel.showPopover();
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const availableBelow = viewportTop + height - rect.bottom - 12;
      const availableAbove = rect.top - viewportTop - 12;
      const menuWidth = Math.min(Math.max(220, rect.width), width - 24);
      panel.style.width = `${menuWidth}px`;
      // Only the popup's border and padding surround the option list.
      const ideal = Math.min(316, (list.current?.scrollHeight ?? 44) + 12);
      const upward = availableBelow < ideal && availableAbove > availableBelow;
      const menuHeight = Math.min(
        ideal,
        Math.max(90, upward ? availableAbove : availableBelow),
      );
      setPosition({
        left: Math.max(
          viewportLeft + 12,
          Math.min(rect.left, viewportLeft + width - menuWidth - 12),
        ),
        top: upward
          ? Math.max(viewportTop + 12, rect.top - menuHeight - 6)
          : rect.bottom + 6,
        width: menuWidth,
        maxHeight: menuHeight,
        "--select-list-height": `${Math.max(44, menuHeight - 12)}px`,
        "--select-collapsed-clip": upward
          ? "inset(100% -8px 0 -8px)"
          : "inset(0 -8px 100% -8px)",
        "--select-offset": upward ? "6px" : "-6px",
      } as CSSProperties);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    const scroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) updatePosition();
    };
    const outside = (event: PointerEvent) => {
      if (
        !anchor.contains(event.target as Node) &&
        !panel.contains(event.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      document.removeEventListener("pointerdown", outside, true);
      if (popoverSupported && panel.matches(":popover-open"))
        panel.hidePopover();
    };
  }, [present, choices.length, popoverSupported]);

  useLayoutEffect(() => {
    const panel = popup.current;
    if (!present || !position || !panel) return;
    const style = getComputedStyle(panel);
    const collapsed = {
      opacity: 0,
      clipPath: style.getPropertyValue("--select-collapsed-clip").trim(),
      transform: `translateY(${style.getPropertyValue("--select-offset").trim()})`,
    };
    const expanded = {
      opacity: 1,
      clipPath: "inset(-8px)",
      transform: "translateY(0px)",
    };
    // Read the current frame before cancelling so rapid toggles reverse smoothly.
    const from =
      popupMotion.current || !open
        ? {
            opacity: style.opacity,
            clipPath: style.clipPath,
            transform: style.transform,
          }
        : collapsed;
    popupMotion.current?.cancel();
    const animation = panel.animate([from, open ? expanded : collapsed], {
      id: "sfmcl-t-select-popup",
      duration: open ? 220 : 160,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
      fill: "both",
    });
    popupMotion.current = animation;
    animation.onfinish = () => {
      if (popupMotion.current !== animation) return;
      popupMotion.current = null;
      if (open) animation.cancel();
      else setPresent(false);
    };
  }, [open, present, !!position]);

  useLayoutEffect(
    () => () => {
      popupMotion.current?.cancel();
      popupMotion.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (open && position)
      list.current
        ?.querySelectorAll<HTMLElement>(".pixel-select-option")
        [active]?.scrollIntoView({ block: "nearest" });
  }, [active, open, !!position]);

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const key = event.key;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      if (!open) show();
      if (key === "Home") setActive(enabled[0] ?? -1);
      else if (key === "End") setActive(enabled.at(-1) ?? -1);
      else if (open && enabled.length) {
        const current = enabled.indexOf(active);
        const next =
          current < 0
            ? key === "ArrowDown"
              ? 0
              : enabled.length - 1
            : (current + (key === "ArrowDown" ? 1 : -1) + enabled.length) %
              enabled.length;
        setActive(enabled[next]);
      }
    } else if (
      hasActions &&
      open &&
      ["ArrowLeft", "ArrowRight"].includes(key)
    ) {
      event.preventDefault();
      setActionActive(key === "ArrowRight" && removable(active));
    } else if (hasActions && open && key === "Delete") {
      event.preventDefault();
      remove(active, true);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (open && activeAction) remove(active, true);
      else if (open && active >= 0) choose(active);
      else if (open) close();
      else show();
    } else if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === "Tab" && open) {
      if (active >= 0 && !hasActions) choose(active);
      else close();
    } else if (
      key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = Date.now();
      const text =
        now - typeahead.current.time > 750 ? key : typeahead.current.text + key;
      typeahead.current = { text, time: now };
      const repeated = [...text].every((character) => character === text[0]);
      const query = (repeated ? text[0] : text).toLocaleLowerCase();
      const start = repeated ? Math.max(0, enabled.indexOf(active) + 1) : 0;
      const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
      const match = ordered.find((index) =>
        choices[index].label.toLocaleLowerCase().startsWith(query),
      );
      if (!open) show();
      if (match !== undefined) {
        setActive(match);
        setActionActive(false);
      }
    }
  };

  return (
    <span className={`pixel-select ${className}`}>
      <button
        {...props}
        ref={trigger}
        id={triggerId}
        type="button"
        role="combobox"
        disabled={disabled}
        className="pixel-select-trigger pixel-surface"
        aria-haspopup={hasActions ? "grid" : "listbox"}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? activeId : undefined}
        data-tooltip={tooltip ?? title ?? choices[selected]?.label}
        onClick={() => (open ? close() : show())}
        onKeyDown={handleKey}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget as Node)) close();
        }}
      >
        <span
          key={animateValue ? value : undefined}
          className={`pixel-select-value ${animateValue ? "is-changing" : ""}`}
        >
          {displayValue ?? (choices[selected]?.label || placeholder)}
        </span>
        <PixelIcon name="chevron" />
      </button>
      {name && <input type="hidden" name={name} value={value} />}
      {present &&
        createPortal(
          <div
            ref={popup}
            popover={popoverSupported ? "manual" : undefined}
            className="pixel-select-popup pixel-surface"
            data-state={open ? "open" : "closed"}
            aria-hidden={!open || undefined}
            inert={!open}
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              ref={list}
              id={listId}
              className="pixel-select-list"
              role={hasActions ? "grid" : "listbox"}
              aria-label={menuLabel}
              aria-colcount={hasActions ? 2 : undefined}
            >
              {choices.length ? (
                choices.map((option, index) => {
                  const selection = (
                    <div
                      id={`${listId}-${index}`}
                      role={hasActions ? "gridcell" : "option"}
                      aria-colspan={
                        hasActions && !removable(index) ? 2 : undefined
                      }
                      aria-selected={option.value === value}
                      aria-disabled={option.disabled || undefined}
                      className={`pixel-select-option pixel-surface ${active === index && !activeAction ? "is-active" : ""}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => choose(index)}
                    >
                      <span
                        className="pixel-option-marker"
                        aria-hidden="true"
                      />
                      <span className="pixel-option-label">
                        {option.label}
                        {option.group && <small>{option.group}</small>}
                      </span>
                      <span className="pixel-option-check">
                        {option.value === value && <PixelIcon name="check" />}
                      </span>
                    </div>
                  );
                  return hasActions ? (
                    <div
                      key={option.value}
                      role="row"
                      className="pixel-select-row"
                    >
                      {selection}
                      {removable(index) && (
                        <div
                          role="gridcell"
                          id={`${listId}-${index}-remove`}
                          className="pixel-option-action"
                        >
                          <button
                            type="button"
                            tabIndex={-1}
                            className={`pixel-option-remove ${active === index && activeAction ? "is-active" : ""}`}
                            aria-label={removeOptionLabel(option.value)}
                            data-tooltip="从列表删除 · Delete"
                            disabled={disabled || optionActionsDisabled}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => remove(index)}
                          >
                            <PixelIcon name="close" />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Fragment key={option.value}>{selection}</Fragment>
                  );
                })
              ) : (
                <div className="pixel-select-empty">暂无可选项目</div>
              )}
            </div>
          </div>,
          trigger.current?.closest("dialog") ?? document.body,
        )}
    </span>
  );
}
