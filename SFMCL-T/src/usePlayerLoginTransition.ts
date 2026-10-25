import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PlayerLoginState } from "./usePlayerLogin";
import { usePageActive } from "./PageActivity";

export function usePlayerLoginTransition(
  root: RefObject<HTMLDivElement | null>,
  active: boolean,
  auth: PlayerLoginState,
) {
  const pageActive = usePageActive();
  const state = !active
    ? ""
    : auth.completed
      ? "completed"
      : auth.expired
        ? "expired"
        : auth.failed
          ? "failed"
          : auth.loading || !auth.login
            ? "preparing"
            : ["waiting", "xbox", "minecraft", "saving"][auth.step];
  const key = state ? `${state}:${auth.step}` : "";
  const previous = useRef(key);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = key;
    // Polling, countdown ticks and browser retries leave the current scene intact.
    // Entering/leaving the login route already has its own navigation animation.
    if (!pageActive || !last || !key || last === key || !root.current) return;
    const direction = state === "preparing" ? -1 : 1;
    const targets = [
      [".players-auth-stage", "stage", 12],
      [".players-identity-top", "identity", 8],
      [".players-login-content", "content", 12],
    ] as const;
    const animations = targets.flatMap(([selector, part, distance]) => {
      const element = root.current?.querySelector<HTMLElement>(selector);
      if (!element) return [];
      return element.animate(
        [
          { opacity: 0, transform: `translateY(${direction * distance}px)` },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          id: `sfmcl-t-player-login-${part}`,
          duration: 280,
          easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
          fill: "both",
        },
      );
    });
    const cleanup = () => animations.forEach((animation) => animation.cancel());
    // Cancel immediately on another state or navigation.
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(cleanup);
    return cleanup;
  }, [key, root, state, pageActive]);

  return state;
}
