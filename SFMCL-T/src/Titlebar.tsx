import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";
import { useApp } from "./store";
import { entryLabel, pagePath } from "./navigation";

export function Titlebar() {
  const { route, navigate, run } = useApp();
  const path = pagePath(route);
  const parent = path.at(-2);
  const labels = (parent ? path.slice(1) : path).slice(-3);
  const pathKey = JSON.stringify([!!parent, ...labels.map(entryLabel)]);
  const [maximized, setMaximized] = useState(false);
  const [visibility, setVisibility] = useState({
    key: "",
    hidden: 0,
    collapsed: 0,
  });
  const hidden = visibility.key === pathKey ? visibility.hidden : 0;
  const collapsed = visibility.key === pathKey ? visibility.collapsed : 0;
  const titlebar = useRef<HTMLElement>(null);
  const breadcrumbs = useRef<HTMLOListElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const dragSpace = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = titlebar.current;
    const list = breadcrumbs.current;
    const probes = measurements.current;
    const drag = dragSpace.current;
    const buttons = controls.current;
    if (!bar || !list || !probes || !drag || !buttons) return;

    const measure = () => {
      const barStyle = getComputedStyle(bar);
      const listStyle = getComputedStyle(list);
      const controlsStyle = getComputedStyle(buttons);
      // Always reserve the back arrow and restore labels when the window widens.
      const backWidth =
        probes
          .querySelector<HTMLElement>(".breadcrumb-back")
          ?.getBoundingClientRect().width ?? 0;
      const gap = parseFloat(listStyle.columnGap);
      const available =
        bar.clientWidth -
        parseFloat(barStyle.paddingLeft) -
        parseFloat(barStyle.paddingRight) -
        buttons.offsetWidth -
        parseFloat(controlsStyle.marginLeft) -
        parseFloat(controlsStyle.marginRight) -
        parseFloat(getComputedStyle(drag).minWidth) -
        (backWidth ? backWidth + gap : 0);
      const widths = Array.from(
        probes.querySelectorAll<HTMLElement>("[data-breadcrumb-width]"),
        (element) => element.getBoundingClientRect().width,
      );
      const separatorWidth = probes
        .querySelector<HTMLElement>(".breadcrumb-separator")!
        .getBoundingClientRect().width;
      const ellipsisWidth = probes
        .querySelector<HTMLElement>(".breadcrumb-ellipsis")!
        .getBoundingClientRect().width;
      const padding =
        parseFloat(listStyle.paddingLeft) + parseFloat(listStyle.paddingRight);
      const requiredWidth = (hidden: number, collapsed: number) =>
        widths
          .slice(hidden)
          .reduce(
            (total, width, index) =>
              total + (index + hidden < collapsed ? ellipsisWidth : width),
            0,
          ) +
        Math.max(0, widths.length - hidden - 1) * (separatorWidth + gap * 2) +
        padding;
      let hidden = 0;
      let collapsed = 0;
      // Shorten all ancestors before hiding any of the three retained labels.
      while (
        collapsed < widths.length - 1 &&
        requiredWidth(0, collapsed) > available
      )
        collapsed++;
      while (
        hidden < widths.length - 1 &&
        requiredWidth(hidden, collapsed) > available
      )
        hidden++;
      setVisibility((previous) =>
        previous.key === pathKey &&
        previous.hidden === hidden &&
        previous.collapsed === collapsed
          ? previous
          : { key: pathKey, hidden, collapsed },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [bar, probes.querySelector("ol")!, drag, buttons])
      observer.observe(element);
    return () => observer.disconnect();
  }, [pathKey]);

  useEffect(() => {
    if (!desktop) return;
    const currentWindow = getCurrentWindow();
    let active = true;
    const syncMaximized = async () => {
      const next = await currentWindow.isMaximized();
      if (active) setMaximized(next);
    };
    const reportError = (error: unknown) =>
      console.error("无法同步窗口状态", error);
    // Native dragging, double-clicks and system shortcuts can also resize the window.
    const listener = currentWindow.onResized(() => {
      void syncMaximized().catch(reportError);
    });
    void listener.catch(reportError);
    void syncMaximized().catch(reportError);
    return () => {
      active = false;
      void listener.then((unlisten) => unlisten()).catch(reportError);
    };
  }, []);

  const control = (action: "minimize" | "toggleMaximize" | "close") => {
    if (desktop) void run(() => getCurrentWindow()[action]());
  };
  const maximizeLabel = maximized ? "还原窗口" : "最大化窗口";
  const buttonTitle = (label: string) =>
    desktop ? label : `${label}（仅桌面应用可用）`;

  return (
    <header
      ref={titlebar}
      className="topbar"
      aria-label="窗口标题栏"
      data-tauri-drag-region={desktop ? "deep" : undefined}
    >
      <nav
        className="topbar-breadcrumb"
        aria-label="页面路径"
        data-tauri-drag-region="false"
      >
        <ol ref={breadcrumbs}>
          {parent && (
            <li key="back">
              <button
                type="button"
                className="breadcrumb-back"
                aria-label="返回上一级"
                data-tooltip={`返回${entryLabel(parent)}`}
                onClick={() => navigate(parent)}
              >
                <ArrowLeft size={17} aria-hidden="true" />
              </button>
            </li>
          )}
          {labels.slice(hidden).map((entry, index, visible) => {
            const label = entryLabel(entry);
            const current = index === visible.length - 1;
            const ellipsis = !current && index + hidden < collapsed;
            return (
              <li key={index}>
                {index > 0 && (
                  <span className="breadcrumb-separator" aria-hidden="true">
                    /
                  </span>
                )}
                {ellipsis && parent ? (
                  <button
                    type="button"
                    className="breadcrumb-ellipsis"
                    aria-label={`返回${label}（省略路径）`}
                    data-tooltip={`返回${label}`}
                    onClick={() => navigate(entry)}
                  >
                    ...
                  </button>
                ) : current ? (
                  <strong aria-current="page" data-tooltip={label}>
                    {label}
                  </strong>
                ) : (
                  <button
                    type="button"
                    data-tooltip={`返回${label}`}
                    onClick={() => navigate(entry)}
                  >
                    {label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div
        ref={measurements}
        className="topbar-breadcrumb breadcrumb-measure"
        aria-hidden="true"
        inert
      >
        <ol>
          {labels.map((entry, index) => (
            <li key={index}>
              {index === labels.length - 1 ? (
                <strong data-breadcrumb-width>{entryLabel(entry)}</strong>
              ) : (
                <button data-breadcrumb-width>{entryLabel(entry)}</button>
              )}
            </li>
          ))}
        </ol>
        {parent && (
          <button className="breadcrumb-back">
            <ArrowLeft size={17} />
          </button>
        )}
        <button className="breadcrumb-ellipsis">...</button>
        <span className="breadcrumb-separator">/</span>
      </div>
      <div
        ref={dragSpace}
        className="topbar-drag-space"
        data-tooltip={desktop ? "拖动窗口，双击最大化或还原" : undefined}
      />
      <div
        ref={controls}
        className="window-controls"
        role="group"
        aria-label="窗口控制"
        data-tauri-drag-region="false"
      >
        <button
          type="button"
          aria-label="最小化窗口"
          data-tooltip={buttonTitle("最小化窗口")}
          disabled={!desktop}
          onClick={() => control("minimize")}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          data-tooltip={buttonTitle(maximizeLabel)}
          disabled={!desktop}
          onClick={() => control("toggleMaximize")}
        >
          {maximized ? (
            <Copy size={13} aria-hidden="true" />
          ) : (
            <Square size={13} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-close"
          aria-label="关闭窗口"
          data-tooltip={buttonTitle("关闭窗口")}
          disabled={!desktop}
          onClick={() => control("close")}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
