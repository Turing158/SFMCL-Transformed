import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { usePageActive } from "./PageActivity";

type Snapshot = { scope: string; loading: boolean; children: ReactNode };
type Frame = { opacity: string; transform: string };

export function VersionDirectoryResults({
  scope,
  loading,
  resultsRef,
  children,
}: Snapshot & { resultsRef: RefObject<HTMLDivElement | null> }) {
  const active = usePageActive();
  const latest = useRef<Snapshot>({ scope, loading, children });
  latest.current = { scope, loading, children };
  const [displayed, setDisplayed] = useState(latest.current);
  const switching = displayed.scope !== scope || displayed.loading !== loading;
  // Data and selection updates in the same directory retain the live nodes.
  if (!switching && displayed.children !== children)
    setDisplayed({ scope, loading, children });

  const content = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const frame = useRef<Frame | null>(null);
  const needsEntry = useRef(false);
  const newContent = useRef(false);

  useLayoutEffect(() => {
    const element = content.current;
    const root = resultsRef.current;
    if (!element || !root) return;
    if (!active || !root.getClientRects().length) {
      needsEntry.current = false;
      newContent.current = false;
      frame.current = null;
      delete root.dataset.versionDirectoryTransition;
      if (switching) setDisplayed(latest.current);
      return;
    }

    const visibleFrame = () => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, transform: style.transform };
    };
    let motion: Animation | undefined;
    if (switching) {
      needsEntry.current = true;
      root.dataset.versionDirectoryTransition = "exit";
      const start = frame.current ?? visibleFrame();
      motion = element.animate(
        [start, { opacity: "0", transform: "translateY(-8px)" }],
        {
          id: "sfmcl-t-version-directory-exit",
          duration: Math.max(40, 160 * Number(start.opacity)),
          easing: "ease-in",
          fill: "both",
        },
      );
      animation.current = motion;
      frame.current = null;
      const exiting = motion;
      void exiting.finished.then(
        () => {
          if (animation.current !== exiting) return;
          newContent.current = true;
          setDisplayed(latest.current);
        },
        () => {},
      );
    } else if (needsEntry.current) {
      const start = newContent.current
        ? { opacity: "0", transform: "translateY(8px)" }
        : (frame.current ?? visibleFrame());
      needsEntry.current = false;
      newContent.current = false;
      frame.current = null;
      root.dataset.versionDirectoryTransition = "enter";
      motion = element.animate(
        [start, { opacity: "1", transform: "translateY(0)" }],
        {
          id: "sfmcl-t-version-directory-enter",
          duration: 240,
          easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
          fill: "both",
        },
      );
      animation.current = motion;
      const entering = motion;
      void entering.finished.then(
        () => {
          if (animation.current !== entering) return;
          animation.current = null;
          entering.cancel();
          delete root.dataset.versionDirectoryTransition;
        },
        () => {},
      );
    } else {
      frame.current = null;
      delete root.dataset.versionDirectoryTransition;
    }

    return () => {
      if (motion) {
        // Reversals continue from the visible frame rather than restarting.
        if (animation.current === motion) {
          frame.current = visibleFrame();
          animation.current = null;
        }
        motion.cancel();
      }
      delete root.dataset.versionDirectoryTransition;
    };
  }, [active, scope, loading, displayed.scope, displayed.loading, resultsRef]);

  return (
    <div ref={resultsRef} id="local-version-results" aria-busy={loading}>
      <div
        ref={content}
        className="version-directory-content"
        inert={switching}
        aria-hidden={switching || undefined}
      >
        {displayed.children}
      </div>
    </div>
  );
}
