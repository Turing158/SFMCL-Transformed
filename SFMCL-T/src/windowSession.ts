import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  DependencyList,
  Dispatch,
  EffectCallback,
  SetStateAction,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAutoSaves } from "./autoSave";

type ScrollPosition = { selector: string; top: number; left: number };
export interface InterfaceSnapshot {
  values: Record<string, unknown>;
  scroll: ScrollPosition[];
  focus?: { selector: string; start: number | null; end: number | null };
}
declare global {
  interface Window {
    __SFMCL_T_SESSION__?: InterfaceSnapshot | null;
    __SFMCL_T_SUSPEND__?: (id: number, launchId: string) => Promise<void>;
  }
}

// Lives only in the launcher process. Drafts never go into localStorage or files.
export class InterfaceState {
  private restored: Map<string, unknown>;
  private mounted = new Map<string, () => unknown>();
  constructor(values: Record<string, unknown> = {}) {
    this.restored = new Map(Object.entries(values));
  }
  read<T>(key: string, initial: T | (() => T)): T {
    return this.restored.has(key)
      ? (this.restored.get(key) as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial;
  }
  register(key: string, read: () => unknown) {
    this.restored.delete(key);
    this.mounted.set(key, read);
    return () => {
      if (this.mounted.get(key) === read) this.mounted.delete(key);
    };
  }
  capture() {
    return Object.fromEntries([
      ...this.restored,
      ...[...this.mounted].map(([key, read]) => [key, read()] as const),
    ]);
  }
}

const restored =
  typeof window === "undefined" ? null : window.__SFMCL_T_SESSION__;
const state = new InterfaceState(restored?.values);
export const InterfaceScope = createContext("app");

export function isRestoringInterface() {
  return !!restored;
}

// Persist view choices and drafts, while operational flags and backend data refresh.
export function useSessionState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const scope = useContext(InterfaceScope);
  const id = `${scope}/${key}`;
  const [value, setValue] = useState(() => state.read(id, initial));
  const current = useRef(value);
  current.current = value;
  useLayoutEffect(() => state.register(id, () => current.current), [id]);
  return [value, setValue];
}

// Derived defaults reset on a user's new choice, never on a restored mount.
export function useSessionChangeEffect(
  effect: EffectCallback,
  dependencies: DependencyList,
) {
  const previous = useRef(dependencies);
  useEffect(() => {
    if (
      dependencies.every((value, index) =>
        Object.is(value, previous.current[index]),
      )
    )
      return;
    previous.current = dependencies;
    return effect();
  }, dependencies);
}

function selectorFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    if (current.id === "root") {
      parts.unshift("#root");
      return parts.join(" > ");
    }
    if (current.matches("main[data-page][data-view]")) {
      parts.unshift(
        `main[data-page="${current.getAttribute("data-page")}"][data-view="${current.getAttribute("data-view")}"]`,
      );
      return parts.join(" > ");
    }
    const index = current.parentElement
      ? [...current.parentElement.children].indexOf(current) + 1
      : 1;
    parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = current.parentElement;
  }
  return `body > ${parts.join(" > ")}`;
}

const positions = new Map<HTMLElement, { top: number; left: number }>();
export function captureInterface(): InterfaceSnapshot {
  const scroll = new Map<string, ScrollPosition>();
  for (const [element, position] of positions) {
    if (element.isConnected) {
      const selector = selectorFor(element);
      scroll.set(selector, { selector, ...position });
    } else positions.delete(element);
  }
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    if (element.scrollTop || element.scrollLeft) {
      const selector = selectorFor(element);
      scroll.set(selector, {
        selector,
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    }
  }
  const active = document.activeElement;
  const input =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active
      : null;
  return {
    values: state.capture(),
    scroll: [...scroll.values()],
    ...(active && active !== document.body
      ? {
          focus: {
            selector: selectorFor(active),
            start: input?.selectionStart ?? null,
            end: input?.selectionEnd ?? null,
          },
        }
      : {}),
  };
}

export function restoreInterfaceLayout() {
  for (const position of restored?.scroll ?? []) {
    const element = document.querySelector<HTMLElement>(position.selector);
    if (!element) continue;
    positions.set(element, { top: position.top, left: position.left });
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
}

export function restorePageScroll(root: HTMLElement) {
  for (const [element, position] of positions) {
    if (root === element || root.contains(element)) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }
}

export function restoreInterfaceFocus() {
  if (!restored?.focus) return;
  const { selector, start, end } = restored.focus;
  const element = document.querySelector<HTMLElement>(selector);
  element?.focus({ preventScroll: true });
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement) &&
    start !== null &&
    end !== null
  ) {
    try {
      element.setSelectionRange(start, end);
    } catch {
      /* Numeric fields have no text selection. */
    }
  }
}

function waitForLaunchProgress(launchId: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let frame = 0;
    let painted = false;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const check = () => {
      const button = document.querySelector<HTMLElement>(
        `.launch-primary[data-launch-job="${CSS.escape(launchId)}"]`,
      );
      const complete =
        button?.dataset.launchRunning === "true" &&
        parseFloat(
          getComputedStyle(button).getPropertyValue("--launch-button-progress"),
        ) >= 100;
      // Wait for the animated fill itself, then give its final frame a paint.
      if (complete && painted) {
        cleanup();
        resolve();
        return;
      }
      painted = complete;
      frame = requestAnimationFrame(check);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else frame = requestAnimationFrame(check);
  });
}

export function initializeWindowSession() {
  let suspension: AbortController | undefined;
  const cancelSuspension = () => suspension?.abort();
  const onScroll = (event: Event) => {
    if (event.target instanceof HTMLElement) {
      if (event.target.closest("main[data-page][hidden]")) return;
      positions.set(event.target, {
        top: event.target.scrollTop,
        left: event.target.scrollLeft,
      });
    }
  };
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("sfmcl-t-window-restoring", cancelSuspension);
  window.__SFMCL_T_SUSPEND__ = async (id, launchId) => {
    cancelSuspension();
    const controller = new AbortController();
    suspension = controller;
    try {
      await waitForLaunchProgress(
        launchId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      );
      if (!(await flushAutoSaves()))
        throw new Error("设置尚未保存，已保留窗口。");
      // Let completed saves commit their final React state before taking a snapshot.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      controller.signal.throwIfAborted();
      await invoke("suspend_launcher_window", {
        id,
        snapshot: captureInterface(),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await invoke("suspend_launcher_window", { id, snapshot: null }).catch(
        console.error,
      );
      window.dispatchEvent(
        new CustomEvent("sfmcl-t-session-error", { detail: String(error) }),
      );
    }
  };
  return () => {
    cancelSuspension();
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("sfmcl-t-window-restoring", cancelSuspension);
    delete window.__SFMCL_T_SUSPEND__;
  };
}

export function useWindowSession(reportError: (message: string) => void) {
  useEffect(() => {
    const onError = (event: Event) =>
      reportError(`无法释放界面：${(event as CustomEvent<string>).detail}`);
    window.addEventListener("sfmcl-t-session-error", onError);
    const listener = isTauri()
      ? getCurrentWindow().listen<string>(
          "sfmcl-t-session-error",
          ({ payload }) => reportError(`无法释放界面：${payload}`),
        )
      : null;
    return () => {
      window.removeEventListener("sfmcl-t-session-error", onError);
      void listener?.then((unlisten) => unlisten()).catch(console.error);
    };
  }, [reportError]);
}
