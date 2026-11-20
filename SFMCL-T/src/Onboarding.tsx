import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check } from "lucide-react";
import { appIcon } from "./branding";
import { Button, PixelFrame } from "./components";
import { useApp } from "./store";
import { thirdPartyOAuthEnabled } from "./playerLoginAvailability";
import type { NavigationEntry } from "./navigation";
import "./onboarding.css";

const steps = [
  {
    id: "players-entry",
    route: { page: "home" },
    location: "左下角 / 角色管理入口",
    title: "从这里进入角色管理",
    description:
      "左下角的头像和角色区域就是角色管理入口。添加、登录或切换角色，都从这里开始。",
    hint: "点击「下一步」，我们会进入角色管理，展开登录菜单。",
    targets: ['[data-tour="players-entry"]'],
  },
  {
    id: "players",
    route: { page: "players" },
    location: "角色管理 / 登录",
    title: "从这里添加你的角色",
    description: `进入角色管理后，点击右上角「登录」，就能选择离线登录、Microsoft 登录${thirdPartyOAuthEnabled ? "、LittleSkin 登录" : ""}或第三方登录。`,
    hint: "选择适合自己的登录方式即可。现在先认识入口，之后再登录。",
    targets: [
      ".onboarding-login-menu",
      '.page[data-page="players"] [data-player-login-trigger]',
    ],
  },
  {
    id: "versions-entry",
    route: { page: "players" },
    location: "左侧导航 / 版本管理入口",
    title: "从这里进入版本管理",
    description:
      "左侧导航的方块图标是「版本管理」入口。在这里管理游戏目录和已经安装的游戏版本。",
    hint: "点击「下一步」，我们会进入版本管理，找到添加目录的位置。",
    targets: ['[data-tour="versions-entry"]'],
  },
  {
    id: "directory",
    route: { page: "versions" },
    location: "版本管理 / 添加游戏目录",
    title: "把游戏目录添加到这里",
    description:
      "目录栏右侧的「＋」用于添加游戏所在目录。添加后，可以切换目录、查看和管理里面的游戏版本。",
    hint: "还没有游戏？之后可以点击右上角「安装新版本」。本步无需选择文件夹。",
    targets: ['.page[data-page="versions"] [data-tour="add-directory"]'],
  },
  {
    id: "java",
    route: { page: "settings" },
    location: "设置 / 全局设置 / Java 运行环境",
    title: "为游戏准备 Java",
    description:
      "Minecraft 需要 Java 运行环境。在这里扫描已安装的 Java，或手动添加 java.exe / javaw.exe，也可以让启动器自动选择兼容版本。",
    hint: "现在不用扫描或修改设置，记住这个位置就好。",
    targets: ['.page[data-page="settings"] [data-setting-group="java"]'],
  },
  {
    id: "downloads",
    route: { page: "downloads" },
    location: "侧栏下载入口 / 下载中心",
    title: "在这里查看下载进度",
    description:
      "点击左下角的下载入口，进入下载中心。游戏和资源的下载进度、操作步骤以及需要重试的任务，都可以在这里查看。",
    hint: "首次使用时这里是空的；开始安装游戏后，就会出现对应任务。",
    targets: ['.page[data-page="downloads"] .stat-grid', ".sidebar-downloads"],
  },
  {
    id: "launch",
    route: { page: "home" },
    location: "开始游戏 / 底部启动区",
    title: "准备好后，从这里出发",
    description:
      "添加角色和游戏后，回到首页，在底部选择版本并启动游戏。当前角色可以在左下角的角色入口切换。",
    hint: "你已经认识了主要入口。完成引导后，可以按自己的节奏开始准备。",
    targets: ['.launch-dock[aria-hidden="false"] .launch-dock-main'],
  },
] satisfies {
  id: string;
  route: NavigationEntry;
  location: string;
  title: string;
  description: string;
  hint: string;
  targets: string[];
}[];

type TourStep = (typeof steps)[number]["id"] | "welcome" | null;
const OnboardingContext = createContext<{ step: TourStep; start: () => void }>({
  step: null,
  start: () => {},
});
export const useOnboarding = () => useContext(OnboardingContext);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const [index, setIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const opened = useRef(false);
  const finishing = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnFocusPending = useRef(false);

  // Wait for both configuration and the splash reveal; an empty player list
  // alone does not identify a new installation.
  useEffect(() => {
    if (app.data.settings.onboardingVersion !== 0 || opened.current) return;
    const show = () => {
      if (
        document.documentElement.hasAttribute("data-startup") ||
        opened.current
      )
        return;
      opened.current = true;
      setIndex(-1);
    };
    const observer = new MutationObserver(show);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-startup"],
    });
    show();
    return () => observer.disconnect();
  }, [app.data.settings.onboardingVersion]);

  useEffect(() => {
    if (index !== null && index >= 0) app.navigate(steps[index].route);
  }, [index, app.navigate]);

  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setSaving(true);
    setError("");
    try {
      if ((app.data.settings.onboardingVersion ?? 0) < 1) {
        await app.autoSaveSettings(app.data.settings, {
          ...app.data.settings,
          onboardingVersion: 1,
        });
      }
      // Keep the active step (and its presentation menu) alive through exit.
      setClosing(true);
    } catch {
      setError("引导状态保存失败，请重试。关闭窗口后，下次仍可继续查看引导。");
      finishing.current = false;
      setSaving(false);
    }
  };

  const exited = () => {
    returnFocusPending.current = true;
    setIndex(null);
    setClosing(false);
    setSaving(false);
    finishing.current = false;
  };

  useEffect(() => {
    if (index !== null || !returnFocusPending.current) return;
    returnFocusPending.current = false;
    // Focusing outside an open modal is ignored; wait for its removal to commit.
    const target = [
      returnFocus.current,
      ...document.querySelectorAll<HTMLElement>(
        '.sidebar [aria-current="page"], .profile-button',
      ),
    ].find(
      (element) =>
        element?.checkVisibility() &&
        !element.closest("[inert]") &&
        !element.matches(":disabled"),
    );
    target?.focus({
      preventScroll: true,
    });
  }, [index]);

  return (
    <OnboardingContext.Provider
      value={{
        step: index === null ? null : index < 0 ? "welcome" : steps[index].id,
        start: () => {
          if (index !== null || finishing.current) return;
          returnFocus.current = document.activeElement as HTMLElement | null;
          setError("");
          setIndex(-1);
        },
      }}
    >
      {children}
      {index !== null && (
        <TourDialog
          index={index}
          saving={saving}
          closing={closing}
          error={error}
          onMove={setIndex}
          onFinish={() => void finish()}
          onExited={exited}
        />
      )}
    </OnboardingContext.Provider>
  );
}

type Rect = { left: number; top: number; width: number; height: number };
type Layout = { rects: Rect[]; left: number; top: number };
type MotionLayout = { card: Rect; rects: Rect[] };
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

function interpolateRect(from: Rect, to: Rect, progress: number): Rect {
  const mix = (start: number, end: number) => start + (end - start) * progress;
  return {
    left: mix(from.left, to.left),
    top: mix(from.top, to.top),
    width: mix(from.width, to.width),
    height: mix(from.height, to.height),
  };
}

function interpolateLayout(
  from: MotionLayout,
  to: MotionLayout,
  progress: number,
): MotionLayout {
  if (progress >= 1) return to;
  const eased = 1 - (1 - progress) ** 3;
  const collapse = (rect: Rect): Rect => ({ ...rect, width: 0, height: 0 });
  return {
    card: interpolateRect(from.card, to.card, eased),
    // Retain each existing frame by its slot. Added frames grow down/right
    // from their own top-left corner; removed ones remain until they collapse.
    rects: Array.from(
      { length: Math.max(from.rects.length, to.rects.length) },
      (_, i) =>
        interpolateRect(
          from.rects[i] ?? collapse(to.rects[i]),
          to.rects[i] ?? collapse(from.rects[i]),
          eased,
        ),
    ),
  };
}

function positionCard(rects: Rect[], width: number, height: number): Layout {
  const margin = 18,
    gap = 18;
  const center = {
    left: (innerWidth - width) / 2,
    top: (innerHeight - height) / 2,
  };
  const target = rects[0];
  if (!target) return { rects, ...center };
  const candidates = [
    { left: target.left - width - gap, top: target.top },
    { left: target.left + target.width + gap, top: target.top },
    {
      left: target.left + (target.width - width) / 2,
      top: target.top + target.height + gap,
    },
    {
      left: target.left + (target.width - width) / 2,
      top: target.top - height - gap,
    },
  ].map((point) => ({
    left: clamp(point.left, margin, innerWidth - width - margin),
    top: clamp(point.top, margin, innerHeight - height - margin),
  }));
  const overlap = (point: typeof center) =>
    rects.reduce(
      (area, rect) =>
        area +
        Math.max(
          0,
          Math.min(point.left + width + gap, rect.left + rect.width) -
            Math.max(point.left - gap, rect.left),
        ) *
          Math.max(
            0,
            Math.min(point.top + height + gap, rect.top + rect.height) -
              Math.max(point.top - gap, rect.top),
          ),
      0,
    );
  candidates.sort((a, b) => overlap(a) - overlap(b));
  return { rects, ...candidates[0] };
}

function TourDialog({
  index,
  saving,
  closing,
  error,
  onMove,
  onFinish,
  onExited,
}: {
  index: number;
  saving: boolean;
  closing: boolean;
  error: string;
  onMove: (index: number) => void;
  onFinish: () => void;
  onExited: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentLayout = useRef<MotionLayout | null>(null);
  const entryStarted = useRef<number | null>(null);
  const currentOpacity = useRef(0);
  const [opacity, setOpacity] = useState(0);
  const [entering, setEntering] = useState(true);
  const exitCallback = useRef(onExited);
  const [layout, setLayout] = useState<MotionLayout | null>(null);
  const [moving, setMoving] = useState(false);
  const [measuredIndex, setMeasuredIndex] = useState<number | null>(null);
  const step = index < 0 ? null : steps[index];
  const last = index === steps.length - 1;

  useLayoutEffect(() => {
    exitCallback.current = onExited;
  }, [onExited]);

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useLayoutEffect(() => {
    if (closing) return;
    heading.current?.focus({ preventScroll: true });
    let frame = 0;
    let scrolled: Element | undefined;
    let transition: {
      from: MotionLayout;
      started: number;
      duration: number;
    } | null = null;
    let destination = "";
    let previous = JSON.stringify(currentLayout.current);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const publish = (value: MotionLayout) => {
      const key = JSON.stringify(value);
      if (key === previous) return;
      previous = key;
      currentLayout.current = value;
      setLayout(value);
    };
    // Keep the last drawn geometry through navigation. A new step or resize
    // starts from that exact frame, including when a previous move is interrupted.
    const measure = (now: number) => {
      frame = requestAnimationFrame(measure);
      if (!content.current) return;
      const targets = (step?.targets ?? []).flatMap((selector) =>
        [...document.querySelectorAll<HTMLElement>(selector)].filter(
          (element) =>
            !element.closest("[hidden]") && element.checkVisibility(),
        ),
      );
      if (
        step &&
        (targets.length !== step.targets.length ||
          document.querySelector("main.page")?.getAttribute("data-page") !==
            step.route.page)
      )
        return;
      const primary = targets[0];
      if (primary && scrolled !== primary) {
        primary.scrollIntoView({
          block:
            step?.id === "java" || step?.id === "downloads"
              ? "start"
              : "nearest",
          inline: "nearest",
          behavior: "instant",
        });
        scrolled = primary;
      }
      // Start as soon as the destination controls mount. Their live bounds
      // follow page/tab motion while the guide moves on the same frames.
      const rects = targets
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          const left = Math.max(8, bounds.left - 6);
          const top = Math.max(8, bounds.top - 6);
          return {
            left,
            top,
            width: Math.max(
              0,
              Math.min(innerWidth - 8, bounds.right + 6) - left,
            ),
            height: Math.max(
              0,
              Math.min(innerHeight - 8, bounds.bottom + 6) - top,
            ),
          };
        })
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const width = content.current.offsetWidth;
      const height = Math.min(content.current.offsetHeight, innerHeight - 36);
      const position = positionCard(rects, width, height);
      const next: MotionLayout = {
        rects,
        card: {
          left: Math.round(position.left),
          top: Math.round(position.top),
          width,
          height,
        },
      };
      const key = JSON.stringify(next);
      if (!currentLayout.current) {
        transition = {
          from: {
            card: {
              ...next.card,
              top: next.card.top + (reducedMotion.matches ? 6 : 18),
            },
            rects: [],
          },
          started: now,
          duration: reducedMotion.matches ? 120 : 260,
        };
      } else if (key !== destination && !transition && key !== previous) {
        transition = {
          from: currentLayout.current,
          started: now,
          duration: reducedMotion.matches ? 160 : 380,
        };
      }
      destination = key;
      if (transition) {
        const progress = Math.min(
          1,
          (now - transition.started) / transition.duration,
        );
        publish(interpolateLayout(transition.from, next, progress));
        if (progress >= 1) transition = null;
      } else {
        publish(next);
      }
      // Fade the complete layer on the same clock as its initial displacement.
      // The clock survives step changes so early input never restarts the fade.
      if (currentOpacity.current < 1) {
        entryStarted.current ??= now;
        const progress = Math.min(
          1,
          (now - entryStarted.current) / (reducedMotion.matches ? 120 : 260),
        );
        currentOpacity.current = 1 - (1 - progress) ** 3;
        setOpacity(currentOpacity.current);
        if (progress >= 1) setEntering(false);
      }
      setMoving(transition !== null);
      setMeasuredIndex(index);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [index, step, closing]);

  useLayoutEffect(() => {
    if (!closing) return;
    const from = currentLayout.current;
    const fromOpacity = currentOpacity.current;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const to = from && {
      card: { ...from.card, top: from.card.top + (reducedMotion ? 6 : 18) },
      rects: [],
    };
    let frame = 0;
    let started: number | null = null;
    const animate = (now: number) => {
      started ??= now;
      const progress = Math.min(
        1,
        (now - started) / (reducedMotion ? 120 : 220),
      );
      if (from && to) {
        const value = interpolateLayout(from, to, progress);
        currentLayout.current = value;
        setLayout(value);
      }
      currentOpacity.current = fromOpacity * (1 - progress) ** 3;
      setOpacity(currentOpacity.current);
      // Keep the modal and focus trap until every part has faded out.
      if (progress >= 1) exitCallback.current();
      else frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [closing]);

  const measured = measuredIndex === index;
  useEffect(() => {
    if (measured) heading.current?.focus({ preventScroll: true });
  }, [index, measured]);
  const rects = layout?.rects ?? [];
  const ready = measured;
  return createPortal(
    <dialog
      ref={dialog}
      className="onboarding-layer"
      data-step={step?.id ?? "welcome"}
      data-moving={moving || !measured || entering || closing}
      data-phase={closing ? "closing" : entering ? "entering" : "open"}
      style={{ opacity }}
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onFinish();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = [
          ...card.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const first = buttons[0],
          lastButton = buttons.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === heading.current)
        ) {
          event.preventDefault();
          lastButton?.focus();
        } else if (!event.shiftKey && document.activeElement === lastButton) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <svg
        className="onboarding-shade"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          <mask id="onboarding-cutout">
            <rect width="100%" height="100%" fill="white" />
            {rects.map((rect, i) => (
              <rect
                key={i}
                x={rect.left}
                y={rect.top}
                width={rect.width}
                height={rect.height}
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(8, 18, 13, 0.62)"
          mask="url(#onboarding-cutout)"
        />
        {rects.map((rect, i) => (
          <rect
            key={i}
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            className="onboarding-outline"
          />
        ))}
      </svg>
      <div
        ref={card}
        className={`onboarding-card has-surface ${step ? "" : "onboarding-welcome"}`}
        style={{
          transform: `translate(${layout?.card.left ?? 0}px, ${layout?.card.top ?? 0}px)`,
          width: layout?.card.width,
          height: layout?.card.height,
          visibility: layout ? "visible" : "hidden",
        }}
      >
        <PixelFrame />
        <div className="onboarding-viewport">
          <div ref={content} className="onboarding-content">
            <div className="onboarding-topline">
              {step
                ? `新手引导 · ${index + 1} / ${steps.length}`
                : "SFMCL-T · 初次见面"}
            </div>
            {step && <p className="onboarding-location">{step.location}</p>}
            <div className="onboarding-heading">
              {!step && (
                <div className="onboarding-emblem has-surface">
                  <PixelFrame />
                  <img src={appIcon} alt="" draggable={false} />
                </div>
              )}
              <h2 id="onboarding-title" ref={heading} tabIndex={-1}>
                {step?.title ?? "欢迎，开启你的新冒险"}
              </h2>
            </div>
            <p id="onboarding-description">
              {step?.description ??
                "花一分钟，认识角色登录、游戏目录、Java 设置和启动入口。我们会带你到对应页面，一起看看它们在哪里。"}
            </p>
            <p className="onboarding-hint">
              {step?.hint ??
                "只需跟随指引，不必现在添加角色或安装游戏。你可以随时跳过，并在设置中重新查看。"}
            </p>
            {step && (
              <div
                className="onboarding-progress"
                aria-label={`第 ${index + 1} 步，共 ${steps.length} 步`}
              >
                {steps.map((item, i) => (
                  <span key={item.id} data-reached={i <= index} />
                ))}
              </div>
            )}
            {step && !ready && (
              <p role="status" className="onboarding-locating">
                正在前往对应位置…
              </p>
            )}
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="onboarding-actions">
              <button
                className="onboarding-skip"
                disabled={saving}
                onClick={onFinish}
              >
                跳过
              </button>
              {step && (
                <Button disabled={saving} onClick={() => onMove(index - 1)}>
                  上一步
                </Button>
              )}
              <Button
                primary
                disabled={saving || !ready}
                onClick={() => (last ? onFinish() : onMove(index + 1))}
              >
                {saving && !closing
                  ? "保存中…"
                  : step
                    ? last
                      ? "完成"
                      : "下一步"
                    : "开始引导"}
                {last ? <Check size={16} /> : <ArrowRight size={16} />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
