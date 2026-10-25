import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { PixelFrame, Skin } from "./components";
import { usePageActive } from "./PageActivity";
import type { Player } from "./types";
import type {
  CameraPose,
  PlayerPreviewMode,
  PreviewReady,
  SkinPreview3DProps,
} from "./playerPreview";
import type { ComponentType } from "react";

export function PlayerSkinPreview({
  player,
  mode,
  onReady,
}: {
  player?: Player;
  mode: PlayerPreviewMode;
  onReady: PreviewReady;
}) {
  const active = usePageActive();
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);
  const camera = useRef<CameraPose | undefined>(undefined);
  const lastCanvas = useRef<HTMLCanvasElement | null>(null);
  const lastSize = useRef({ width: 0, height: 0 });
  const hold = useRef<HTMLCanvasElement | null>(null);
  const [component, setComponent] =
    useState<ComponentType<SkinPreview3DProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(mode === "3d");
  const previousMode = useRef(mode);
  const recoveryCleanup = useRef(() => {});

  useLayoutEffect(() => {
    if (!active) {
      hold.current?.remove();
      hold.current = null;
      lastCanvas.current = null;
      return;
    }
    if (previousMode.current !== mode) {
      setFailed(false);
      setLoading(mode === "3d");
      const source = hold.current || lastCanvas.current;
      if (source && (mode === "3d" || previousMode.current === "3d")) {
        const copy = document.createElement("canvas");
        copy.width = source.width;
        copy.height = source.height;
        copy.getContext("2d")?.drawImage(source, 0, 0);
        copy.className = "players-preview-hold";
        copy.setAttribute("aria-hidden", "true");
        const box = source.getBoundingClientRect();
        copy.style.width = `${box.width || lastSize.current.width}px`;
        copy.style.height = `${box.height || lastSize.current.height}px`;
        hold.current?.remove();
        root.current?.append(copy);
        hold.current = copy;
      }
    }
    previousMode.current = mode;
  }, [mode, active]);

  useLayoutEffect(() => {
    recoveryCleanup.current();
    if (!active || mode !== "3d") return;
    let current = true;
    setFailed(false);
    setLoading(true);
    void import("./SkinPreview3D")
      .then((module) => {
        if (current) setComponent(() => module.default);
      })
      .catch(() => {
        if (current) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [mode, active, retry]);

  useLayoutEffect(
    () => () => {
      hold.current?.remove();
      recoveryCleanup.current();
    },
    [],
  );

  const ready = useCallback<PreviewReady>(
    (canvas, draw, frame) => {
      onReady(canvas, draw, frame);
      lastCanvas.current = canvas;
      lastSize.current = {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      hold.current?.remove();
      hold.current = null;
      setLoading(false);
    },
    [onReady],
  );
  const fail = useCallback((canvas?: HTMLCanvasElement) => {
    setFailed(true);
    setLoading(false);
    recoveryCleanup.current();
    if (canvas) {
      const restored = () => setRetry((value) => value + 1);
      canvas.addEventListener("webglcontextrestored", restored, { once: true });
      recoveryCleanup.current = () =>
        canvas.removeEventListener("webglcontextrestored", restored);
    }
  }, []);
  const ThreeD = component;
  const show3d = mode === "3d" && !failed;
  return (
    <div
      ref={root}
      className={`players-figure ${show3d ? "players-figure-3d" : ""} ${player ? "" : "is-empty"}`}
      data-preview-mode={mode}
      data-preview-status={failed ? "failed" : loading ? "loading" : "ready"}
      aria-busy={show3d && loading}
    >
      {show3d ? (
        <>
          <canvas
            ref={surface}
            className="players-3d-surface"
            aria-hidden="true"
            style={{ visibility: loading ? "hidden" : undefined }}
          />
          {active && ThreeD && (
            <ThreeD
              key={retry}
              player={player}
              surface={surface}
              camera={camera}
              onReady={ready}
              onFailure={fail}
            />
          )}
        </>
      ) : (
        <Skin player={player} back={mode === "back"} onDraw={ready} />
      )}
      {active && show3d && loading && (
        <span
          className="players-preview-loading has-surface"
          role="status"
          aria-label="正在加载 3D 模型"
        >
          <PixelFrame />
          <LoaderCircle size={24} className="spin" aria-hidden="true" />
        </span>
      )}
      {mode === "3d" && failed && (
        <span className="players-preview-status" role="status">
          3D 暂不可用{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </span>
      )}
    </div>
  );
}
