import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useApp } from "./store";
import { useImageResource } from "./useImageResource";
import { beginStartupWork } from "./startupReadiness";
import { AnimatedSwap } from "./AnimatedSwap";
import { useModalMotion } from "./useModalMotion";
import "./error-banner.css";
import "./split-button.css";
import "./collapsible-panel.css";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import {
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import { statusLabel } from "./api";
import type { Player, Status, Step } from "./types";

// The three frame layers stay behind the content, without clipping focus rings
// or creating a containing block for fixed-position menus.
export function PixelFrame() {
  return <i className="surface-frame" aria-hidden="true" />;
}

export function CollapsiblePanel({
  className,
  title,
  icon: Icon,
  open,
  onToggle,
  children,
}: {
  className: string;
  title: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <article className={`panel has-surface collapsible-panel ${className}`}>
      <PixelFrame />
      <h2>
        <button
          type="button"
          className="collapsible-panel-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{title}</span>
          <ChevronDown
            className="collapsible-panel-chevron"
            size={18}
            aria-hidden="true"
          />
        </button>
      </h2>
      <div
        id={id}
        className="collapsible-panel-reveal"
        aria-hidden={!open}
        inert={!open}
      >
        <div>
          <div className="collapsible-panel-body">{children}</div>
        </div>
      </div>
    </article>
  );
}

export function Button({
  children,
  primary = false,
  danger = false,
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`has-surface button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${className}`}
    >
      <PixelFrame />
      {children}
    </button>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon has-surface">
        <PixelFrame />
        {icon || <Box size={30} aria-hidden="true" />}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Badge({
  status,
  children,
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  status?: Status;
}) {
  return (
    <span
      {...props}
      className={`has-surface badge ${status || ""} ${className}`}
    >
      <PixelFrame />
      {status ? statusLabel[status] : children}
    </span>
  );
}

export function TabList({
  id,
  label,
  value,
  onValueChange,
  items,
  className = "",
  disabled = false,
  separator,
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  items: {
    value: string;
    label: string;
    icon?: ReactNode;
    count?: number;
    loading?: boolean;
  }[];
  className?: string;
  disabled?: boolean;
  separator?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const measure = () => {
      const selected = list.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      if (!selected || !selected.getClientRects().length) {
        setIndicator(null);
        return;
      }
      // Layout coordinates keep the highlight attached to the scrolling tabs
      // without incorporating an ancestor dialog's animated scale.
      const next = {
        left: selected.offsetLeft,
        top: selected.offsetTop,
        width: selected.offsetWidth,
        height: selected.offsetHeight,
      };
      setIndicator((previous) =>
        previous &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    list
      .querySelectorAll('[role="tab"]')
      .forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [value, items]);

  const focusTab = (index: number) => {
    if (disabled) return;
    const item = items[index];
    if (!item) return;
    onValueChange(item.value);
    const button =
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <div className={`has-surface tabs ${className}`}>
      <PixelFrame />
      <div
        ref={ref}
        className="tab-items"
        role="tablist"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || !items.length)
            return;
          const index = items.findIndex((item) => item.value === value);
          let next: number;
          switch (event.key) {
            case "ArrowRight":
              next = (index + 1) % items.length;
              break;
            case "ArrowLeft":
              next = (index - 1 + items.length) % items.length;
              break;
            case "Home":
              next = 0;
              break;
            case "End":
              next = items.length - 1;
              break;
            default:
              return;
          }
          event.preventDefault();
          focusTab(next);
        }}
      >
        {indicator && (
          <span
            className="tab-indicator has-surface"
            aria-hidden="true"
            style={{
              transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
              width: indicator.width,
              height: indicator.height,
            }}
          >
            <PixelFrame />
          </span>
        )}
        {items.map((item, index) => (
          <Fragment key={item.value}>
            {index > 0 && separator != null && (
              <span className="tab-separator" aria-hidden="true">
                {separator}
              </span>
            )}
            <button
              type="button"
              role="tab"
              disabled={disabled}
              id={`${id}-tab-${item.value}`}
              aria-controls={`${id}-panel`}
              aria-selected={value === item.value}
              aria-busy={item.loading || undefined}
              tabIndex={value === item.value ? 0 : -1}
              className={`has-surface ${value === item.value ? "active" : ""}`}
              onClick={(event) => {
                onValueChange(item.value);
                event.currentTarget.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                });
              }}
            >
              <PixelFrame />
              <span className="tab-content">
                {item.icon}
                {item.label}
                {(item.loading || item.count !== undefined) && (
                  <Badge
                    className="tab-count"
                    aria-label={item.loading ? "正在加载" : undefined}
                  >
                    {item.loading ? (
                      <LoaderCircle
                        size={12}
                        className="spin"
                        aria-hidden="true"
                      />
                    ) : (
                      item.count
                    )}
                  </Badge>
                )}
              </span>
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function TabPanel({
  id,
  value,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  id: string;
  value: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      {...props}
      className={`tab-panel ${props.className || ""}`}
      id={`${id}-panel`}
      role="tabpanel"
      aria-labelledby={`${id}-tab-${value}`}
      tabIndex={0}
    />
  );
}
function isDialogBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

export function ErrorBanner({
  message,
  children,
  tone = "error",
  compact = false,
}: {
  message: string;
  children?: ReactNode;
  tone?: "error" | "info";
  compact?: boolean;
}) {
  const [display, setDisplay] = useState({ message, present: !!message });
  const open = !!message;
  if (open && (display.message !== message || !display.present)) {
    setDisplay({ message, present: true });
  }
  return (
    <div
      className="error-banner"
      data-open={open}
      data-tone={tone}
      data-compact={compact || undefined}
      hidden={!display.present}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "grid-template-rows" &&
          !open
        ) {
          setDisplay((current) => ({ ...current, present: false }));
        }
      }}
    >
      <div className="error-banner-clip">
        {display.present && (
          <div
            className="inline-error resource-error"
            role={tone === "error" ? "alert" : "status"}
          >
            <span className="error-banner-message">
              {message || display.message}
            </span>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  closeDisabled = false,
  descriptionId,
  showError = true,
}: {
  title: string;
  children: ReactNode | ((requestClose: () => boolean) => ReactNode);
  onClose: () => void;
  wide?: boolean;
  className?: string;
  closeDisabled?: boolean;
  descriptionId?: string;
  showError?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const startedOnBackdrop = useRef(false);
  const titleId = useId();
  const { error, clearError } = useApp();
  const requestClose = useModalMotion(ref, onClose, closeDisabled);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={`has-surface modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onPointerDownCapture={(event) => {
        // A drag from the content to the backdrop can also target the dialog
        // in its final click. Only a press that began outside may dismiss it.
        startedOnBackdrop.current =
          event.button === 0 && isDialogBackdrop(event);
      }}
      onPointerCancelCapture={() => {
        startedOnBackdrop.current = false;
      }}
      onClick={(event) => {
        const shouldClose =
          startedOnBackdrop.current && isDialogBackdrop(event);
        startedOnBackdrop.current = false;
        if (shouldClose) requestClose();
      }}
    >
      <PixelFrame />
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button has-surface"
          aria-label="关闭对话框"
          disabled={closeDisabled}
          onClick={requestClose}
        >
          <PixelFrame />
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">
        <ErrorBanner message={showError ? error : ""}>
          <button
            className="icon-button has-surface"
            aria-label="关闭错误提示"
            onClick={clearError}
          >
            <PixelFrame />
            <X size={16} />
          </button>
        </ErrorBanner>
        {typeof children === "function" ? children(requestClose) : children}
      </div>
    </dialog>
  );
}
export function Steps({
  steps,
  animated = false,
}: {
  steps: Step[];
  animated?: boolean;
}) {
  const glyph = (step: Step, index: number) =>
    step.status === "completed" ? (
      <Check size={13} />
    ) : step.status === "running" ? (
      <LoaderCircle size={13} className="spin" />
    ) : (
      index + 1
    );
  return (
    <ol className={`steps ${animated ? "steps-animated" : ""}`}>
      {steps.map((s, i) => (
        <li
          key={`${s.name}-${i}`}
          className={s.status}
          aria-label={
            animated ? `${s.name}：${statusLabel[s.status]}` : undefined
          }
        >
          <span className="step-number has-surface">
            <PixelFrame />
            {animated ? (
              <AnimatedSwap value={s.status} className="step-glyph">
                {glyph(s, i)}
              </AnimatedSwap>
            ) : (
              glyph(s, i)
            )}
          </span>
          <div>
            <strong data-tooltip={s.name}>{s.name}</strong>
            {animated ? (
              <small data-tooltip={s.detail || undefined}>
                <AnimatedSwap value={s.detail}>{s.detail}</AnimatedSwap>
              </small>
            ) : (
              s.detail && <small>{s.detail}</small>
            )}
          </div>
          {i < steps.length - 1 && (
            <ChevronRight className="step-arrow" size={15} />
          )}
        </li>
      ))}
    </ol>
  );
}
export function useImage(path: string, fallback = "") {
  return useImageResource(path, fallback).url;
}
export function ResourceImage({
  path,
  alt,
  fallback = "/assets/DefaultGameIcon/Minecraft.png",
}: {
  path: string;
  alt: string;
  fallback?: string;
}) {
  const url = useImage(path, fallback);
  return (
    <img
      src={url || fallback}
      alt={alt}
      className="resource-icon"
      draggable={false}
      onError={(e) => {
        e.currentTarget.onerror = null;
        e.currentTarget.src = fallback;
      }}
    />
  );
}
export function Skin({
  player,
  face = false,
  back = false,
  showCape = false,
  onDraw,
}: {
  player?: Player;
  face?: boolean;
  back?: boolean;
  showCape?: boolean;
  onDraw?: (canvas: HTMLCanvasElement, draw: () => void) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { url, ready, revision } = useImageResource(
    player?.skin || "",
    "/assets/steve.png",
    true,
  );
  const { url: capeUrl, ready: capeReady } = useImageResource(
    showCape && !face && player?.online ? player.cape || "" : "",
    "",
    true,
  );
  useEffect(() => {
    // Keep the previous pixels until the current resource has actually resolved.
    if (!ready || !capeReady) return;
    let active = true;
    const finishStartupDraw = beginStartupWork();
    const img = new Image();
    img.crossOrigin = "anonymous";
    const cape = capeUrl ? new Image() : null;
    let capeLoaded = !cape;
    let capeValid = false;
    const render = () => {
      if (!active) return;
      const c = canvas.current;
      if (!c) {
        finishStartupDraw();
        return;
      }
      const ctx = c.getContext("2d");
      if (!ctx) {
        finishStartupDraw();
        return;
      }
      const draw = () => {
        const s = img.width / 64;
        const modern = img.height === img.width;
        const slim = !!player?.slim;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = false;
        const drawCape = () => {
          if (cape && capeValid)
            ctx.drawImage(cape, back ? 1 : 12, 1, 10, 16, 3, 9, 10, 16);
        };
        const part = (
          sx: number,
          sy: number,
          w: number,
          h: number,
          dx: number,
          dy: number,
          flip = false,
        ) => {
          ctx.save();
          if (flip) {
            ctx.translate(dx + w, dy);
            ctx.scale(-1, 1);
            dx = 0;
            dy = 0;
          }
          ctx.drawImage(img, sx * s, sy * s, w * s, h * s, dx, dy, w, h);
          ctx.restore();
        };
        if (face) {
          part(8, 8, 8, 8, 0, 0);
          part(40, 8, 8, 8, 0, 0);
          return;
        }
        if (!back) drawCape();
        if (back) {
          const arm = slim ? 3 : 4;
          part(24, 8, 8, 8, 4, 1);
          part(32, 20, 8, 12, 4, 9);
          part(modern && slim ? 51 : 52, 20, arm, 12, 12, 9);
          part(
            modern ? (slim ? 43 : 44) : 52,
            modern ? 52 : 20,
            arm,
            12,
            slim ? 1 : 0,
            9,
            !modern,
          );
          part(12, 20, 4, 12, 8, 21);
          part(modern ? 28 : 12, modern ? 52 : 20, 4, 12, 4, 21, !modern);
          if (modern) {
            part(32, 36, 8, 12, 4, 9);
            part(slim ? 51 : 52, 36, arm, 12, 12, 9);
            part(slim ? 59 : 60, 52, arm, 12, slim ? 1 : 0, 9);
            part(12, 36, 4, 12, 8, 21);
            part(12, 52, 4, 12, 4, 21);
          }
          part(56, 8, 8, 8, 4, 1);
          drawCape();
          return;
        }
        part(8, 8, 8, 8, 4, 1);
        part(20, 20, 8, 12, 4, 9);
        part(44, 20, slim ? 3 : 4, 12, slim ? 1 : 0, 9);
        part(
          modern ? 36 : 44,
          modern ? 52 : 20,
          slim ? 3 : 4,
          12,
          12,
          9,
          !modern,
        );
        part(4, 20, 4, 12, 4, 21);
        part(modern ? 20 : 4, modern ? 52 : 20, 4, 12, 8, 21, !modern);
        if (modern) {
          part(20, 36, 8, 12, 4, 9);
          part(44, 36, slim ? 3 : 4, 12, slim ? 1 : 0, 9);
          part(52, 52, slim ? 3 : 4, 12, 12, 9);
          part(4, 36, 4, 12, 4, 21);
          part(4, 52, 4, 12, 8, 21);
        }
        part(40, 8, 8, 8, 4, 1);
      };
      if (onDraw) onDraw(c, draw);
      else draw();
      finishStartupDraw();
    };
    img.onload = () => {
      if (capeLoaded) render();
    };
    if (cape) {
      cape.crossOrigin = "anonymous";
      const capeDone = () => {
        if (!active) return;
        capeLoaded = true;
        capeValid = cape.naturalWidth === 64 && cape.naturalHeight === 32;
        if (img.complete && img.naturalWidth > 0) render();
      };
      cape.onload = capeDone;
      cape.onerror = capeDone;
      cape.src = capeUrl;
    }
    img.onerror = () => {
      if (img.src.endsWith("/assets/steve.png")) {
        finishStartupDraw();
        return;
      }
      img.src = "/assets/steve.png";
    };
    img.src = url;
    return () => {
      active = false;
      finishStartupDraw();
    };
  }, [
    url,
    ready,
    revision,
    capeUrl,
    capeReady,
    face,
    back,
    player?.slim,
    onDraw,
  ]);
  return (
    <canvas
      ref={canvas}
      width={face ? 8 : 16}
      height={face ? 8 : 34}
      className={face ? "skin-face" : "skin-body"}
      draggable={false}
      role="img"
      aria-label={`${player?.name || "Steve"} 的${face ? "头像" : `${back ? "背面" : "正面"}皮肤预览`}`}
    />
  );
}
