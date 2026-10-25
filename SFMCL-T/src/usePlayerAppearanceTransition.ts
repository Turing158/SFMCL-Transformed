import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Player } from "./types";
import { usePageActive } from "./PageActivity";
import type { PlayerPreviewMode, PreviewReady } from "./playerPreview";

const timing: KeyframeAnimationOptions = {
  duration: 360,
  easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
  fill: "both",
};

export function usePlayerAppearanceTransition(
  player?: Player,
  scope = "",
  mode: PlayerPreviewMode = "front",
  animateName = true,
) {
  const pageActive = usePageActive();
  const name = player?.name || "Steve";
  const identity = JSON.stringify([player?.uuid, player?.skin]);
  const preview = JSON.stringify([!!player?.slim, mode]);
  const nameRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef<{
    identity: string;
    preview: string;
    pixels: string;
    name: string;
    mode: PlayerPreviewMode;
    capture: () => HTMLCanvasElement;
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
  } | null>(null);
  const stop = useRef(() => {});
  const [displayed, setDisplayed] = useState({ name, scope });

  useLayoutEffect(
    () => () => {
      stop.current();
      previous.current = null;
    },
    [scope, pageActive],
  );

  const onSkinDraw = useCallback<PreviewReady>(
    (canvas, draw, frame) => {
      if (!pageActive) {
        draw();
        previous.current = null;
        setDisplayed((current) =>
          current.name === name && current.scope === scope
            ? current
            : { name, scope },
        );
        return;
      }
      const last = previous.current;
      // Continue from the visible side when a flip is interrupted halfway.
      const visibleSkin =
        getComputedStyle(canvas).opacity === "0"
          ? canvas.parentElement?.querySelector<HTMLCanvasElement>(
              ".players-skin-outgoing",
            ) || canvas
          : canvas;
      const skinStyle = getComputedStyle(visibleSkin);
      const skinStart = {
        transform: skinStyle.transform,
        opacity: skinStyle.opacity,
      };
      const heading = nameRef.current;
      const nameStyle = heading && getComputedStyle(heading);
      const nameStart = {
        transform: nameStyle?.transform || "none",
        opacity: nameStyle?.opacity || "1",
      };
      // A frozen copy cannot be redrawn by cache invalidation or a late image load.
      const outgoing = document.createElement("canvas");
      const old =
        (visibleSkin !== canvas ? visibleSkin : undefined) ||
        (last?.canvas === canvas ? frame?.outgoing : undefined) ||
        (last?.mode === "3d" || last?.canvas !== canvas
          ? last?.capture()
          : visibleSkin) ||
        visibleSkin;
      outgoing.width = old.width;
      outgoing.height = old.height;
      outgoing.getContext("2d")?.drawImage(old, 0, 0);
      draw();
      const pixels = frame?.fingerprint || canvas.toDataURL();
      const previewChanged =
        !!last && last.identity === identity && last.preview !== preview;
      const skinChanged =
        !!last &&
        !previewChanged &&
        (last.identity !== identity || last.pixels !== pixels);
      const nameChanged =
        animateName && !!last && (skinChanged || last.name !== name);
      const capture =
        frame?.capture ||
        (() => {
          const copy = document.createElement("canvas");
          copy.width = canvas.width;
          copy.height = canvas.height;
          copy.getContext("2d")?.drawImage(canvas, 0, 0);
          return copy;
        });
      previous.current = {
        identity,
        preview,
        pixels,
        name,
        mode,
        capture,
        canvas,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      if (!skinChanged && !previewChanged && !nameChanged) {
        setDisplayed((current) =>
          current.name === name && current.scope === scope
            ? current
            : { name, scope },
        );
        return;
      }
      stop.current();

      const animations: Animation[] = [];
      const ghosts: HTMLElement[] = [];
      if (skinChanged || previewChanged) {
        outgoing.className = "players-skin-outgoing";
        outgoing.setAttribute("aria-hidden", "true");
        canvas.parentElement?.append(outgoing);
        ghosts.push(outgoing);
        if (previewChanged && (mode === "3d" || last?.mode === "3d")) {
          outgoing.style.width = `${last.width}px`;
          outgoing.style.height = `${last.height}px`;
          outgoing.style.left = "50%";
          outgoing.style.top = "50%";
          outgoing.style.translate = "-50% -50%";
          animations.push(
            outgoing.animate(
              [skinStart, { transform: "scale(0.96)", opacity: 0 }],
              timing,
            ),
            canvas.animate(
              [
                { transform: "scale(0.96)", opacity: 0 },
                { transform: "none", opacity: 1 },
              ],
              timing,
            ),
          );
        } else if (previewChanged) {
          const flipTiming = { ...timing, easing: "ease-in-out" };
          // Swap sides edge-on, without sliding the skin or fading the name.
          animations.push(
            outgoing.animate(
              [
                skinStart,
                { transform: "rotateY(-90deg)", opacity: 1, offset: 0.5 },
                { transform: "rotateY(-90deg)", opacity: 0, offset: 0.5 },
                { transform: "rotateY(-90deg)", opacity: 0 },
              ],
              flipTiming,
            ),
            canvas.animate(
              [
                { transform: "rotateY(90deg)", opacity: 0 },
                { transform: "rotateY(90deg)", opacity: 0, offset: 0.5 },
                { transform: "rotateY(90deg)", opacity: 1, offset: 0.5 },
                { transform: "rotateY(0deg)", opacity: 1 },
              ],
              flipTiming,
            ),
          );
        } else {
          const stage = canvas.closest<HTMLElement>(".players-stage");
          const distance =
            (stage?.clientWidth || canvas.clientWidth * 2) / 2 +
            canvas.clientWidth;
          animations.push(
            outgoing.animate(
              [
                skinStart,
                { transform: `translateX(-${distance}px)`, opacity: 0 },
              ],
              timing,
            ),
            canvas.animate(
              [
                { transform: `translateX(${distance}px)`, opacity: 0 },
                { transform: "translateX(0)", opacity: 1 },
              ],
              timing,
            ),
          );
        }
      }

      if (nameChanged && heading) {
        const outgoingName = document.createElement("span");
        outgoingName.className = "players-name-outgoing";
        outgoingName.textContent = last.name;
        outgoingName.setAttribute("aria-hidden", "true");
        heading.parentElement?.append(outgoingName);
        ghosts.push(outgoingName);
        animations.push(
          outgoingName.animate(
            [nameStart, { transform: "translateY(-100%)", opacity: 0 }],
            timing,
          ),
        );
      }
      flushSync(() =>
        setDisplayed((current) =>
          current.name === name && current.scope === scope
            ? current
            : { name, scope },
        ),
      );
      if (nameChanged && heading) {
        animations.push(
          heading.animate(
            [
              { transform: "translateY(100%)", opacity: 0 },
              { transform: "translateY(0)", opacity: 1 },
            ],
            timing,
          ),
        );
      }

      const cleanup = () => {
        animations.forEach((animation) => animation.cancel());
        ghosts.forEach((ghost) => ghost.remove());
      };
      stop.current = cleanup;
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(cleanup);
    },
    [identity, preview, name, scope, animateName, pageActive, mode],
  );

  return {
    nameRef,
    displayedName:
      animateName && displayed.scope === scope ? displayed.name : name,
    onSkinDraw,
  };
}
