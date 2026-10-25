import { useEffect, useRef, useState } from "react";
import { Player3DRenderer } from "./skinview3dAdapter";
import { nextPlayer3DAction, player3dActionLabel } from "./player3dActions";
import type { Player3DAction } from "./player3dActions";
import { useImageResource } from "./useImageResource";
import type { SkinPreview3DProps } from "./playerPreview";

async function decodeImage(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  return image;
}

function texturePixels(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return canvas.toDataURL();
}

export default function SkinPreview3D({
  player,
  onReady,
  onFailure,
  camera,
  surface,
}: SkinPreview3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLDivElement | null>(null);
  const renderer = useRef<Player3DRenderer | null>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const failureCallback = useRef(onFailure);
  failureCallback.current = onFailure;
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<Player3DAction>("still");
  const currentAction = useRef<Player3DAction>("still");
  const { url, ready, revision } = useImageResource(
    player?.skin || "",
    "/assets/steve.png",
    true,
  );
  const capePath = player?.online ? player.cape || "" : "";
  const { url: capeUrl, ready: capeReady } = useImageResource(
    capePath,
    "",
    true,
  );
  const request = JSON.stringify([
    player?.uuid,
    player?.skin,
    player?.slim,
    player?.name,
    capePath,
    capeUrl,
    capeReady,
    url,
    revision,
    ready,
  ]);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const committed = useRef("");
  const pendingCommit = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mount = host.current;
    const stage = mount?.closest<HTMLElement>(".players-stage");
    if (!mount || !stage) return;
    // StrictMode runs setup/cleanup twice on the same DOM. A context that was
    // explicitly lost must never be reused by the next viewer.
    const canvas = document.createElement("canvas");
    canvas.className = "players-3d-canvas";
    canvas.setAttribute("aria-hidden", "true");
    mount.append(canvas);
    // Keep render dimensions tied to the figure, while gestures use the scene.
    const region = document.createElement("div");
    region.className = "players-3d-input";
    region.tabIndex = 0;
    region.setAttribute("role", "button");
    stage.append(region);
    input.current = region;
    let active = true;
    let adapter: Player3DRenderer | null = null;
    let initializationFailed = false;
    const create = () => {
      if (
        !active ||
        adapter ||
        initializationFailed ||
        !canvas.clientWidth ||
        !canvas.clientHeight
      )
        return;
      try {
        adapter = new Player3DRenderer(
          canvas,
          (source) => {
            const target = surface.current;
            if (!active || !target) return;
            target.width = source.width;
            target.height = source.height;
            target.getContext("2d")?.drawImage(source, 0, 0);
            camera.current = adapter?.getPose();
            const commit = pendingCommit.current;
            pendingCommit.current = null;
            commit?.();
          },
          camera.current,
          region,
        );
        renderer.current = adapter;
        adapter.setSize(canvas.clientWidth, canvas.clientHeight);
        setGeneration((value) => value + 1);
      } catch (error) {
        initializationFailed = true;
        if (import.meta.env.DEV)
          console.error("3D preview initialization failed", error);
        failureCallback.current();
      }
    };
    const resize = () => {
      create();
      adapter?.setSize(canvas.clientWidth, canvas.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    observer.observe(region);
    resize();
    const lost = (event: Event) => {
      event.preventDefault();
      pendingCommit.current = null;
      failureCallback.current(canvas);
    };
    canvas.addEventListener("webglcontextlost", lost);
    let lastClickAction: Player3DAction | null = null;
    let pointer: {
      id: number;
      x: number;
      y: number;
      moved: boolean;
      player: boolean;
    } | null = null;
    let clickAllowed = false;
    const nextAction = () => {
      if (!adapter) return;
      currentAction.current = nextPlayer3DAction(currentAction.current);
      setAction(currentAction.current);
    };
    const hitsPlayer = (x: number, y: number) => {
      const target = surface.current;
      if (
        !target ||
        mount.closest<HTMLElement>(".players-figure")?.dataset.previewStatus !==
          "ready"
      )
        return false;
      const box = target.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      // Use the stable preview area so moving limbs and transparent gaps do not
      // make the click target disappear during an animation.
      const tolerance = 6;
      return (
        x >= box.left - tolerance &&
        x <= box.right + tolerance &&
        y >= box.top - tolerance &&
        y <= box.bottom + tolerance
      );
    };
    const down = (event: PointerEvent) => {
      clickAllowed = false;
      if (pointer) {
        pointer.moved = true;
        return;
      }
      if (event.button !== 0 || !event.isPrimary) return;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        player: hitsPlayer(event.clientX, event.clientY),
      };
      region.dataset.dragging = "true";
    };
    const move = (event: PointerEvent) => {
      region.dataset.playerHit = String(
        hitsPlayer(event.clientX, event.clientY),
      );
      if (pointer?.id !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5
      ) {
        pointer.moved = true;
        lastClickAction = null;
      }
    };
    const up = (event: PointerEvent) => {
      if (pointer?.id !== event.pointerId) return;
      move(event);
      clickAllowed = !pointer.moved && pointer.player;
      pointer = null;
      delete region.dataset.dragging;
    };
    const cancel = () => {
      pointer = null;
      clickAllowed = false;
      lastClickAction = null;
      delete region.dataset.dragging;
    };
    const click = (event: MouseEvent) => {
      if (event.detail === 0) {
        lastClickAction = null;
        nextAction();
        return;
      }
      if (clickAllowed) {
        if (event.detail % 2 === 1) {
          lastClickAction = currentAction.current;
          nextAction();
        } else if (lastClickAction !== null) {
          // Respond immediately to singles; a recognized double-click restores
          // the action from before its first click as well as the camera.
          currentAction.current = lastClickAction;
          setAction(lastClickAction);
          lastClickAction = null;
        }
      } else {
        lastClickAction = null;
      }
      clickAllowed = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        lastClickAction = null;
        if (!event.repeat) nextAction();
        return;
      }
      if (adapter?.key(event.key)) event.preventDefault();
    };
    const reset = () => {
      adapter?.reset();
    };
    const leave = () => delete region.dataset.playerHit;
    region.addEventListener("pointerdown", down);
    region.addEventListener("pointermove", move);
    region.addEventListener("pointerup", up);
    region.addEventListener("pointercancel", cancel);
    region.addEventListener("pointerleave", leave);
    region.addEventListener("click", click);
    region.addEventListener("keydown", key);
    region.addEventListener("dblclick", reset);
    return () => {
      active = false;
      cancel();
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      region.removeEventListener("keydown", key);
      region.removeEventListener("dblclick", reset);
      region.removeEventListener("pointerdown", down);
      region.removeEventListener("pointermove", move);
      region.removeEventListener("pointerup", up);
      region.removeEventListener("pointercancel", cancel);
      region.removeEventListener("pointerleave", leave);
      region.removeEventListener("click", click);
      if (adapter) camera.current = adapter.getPose();
      adapter?.dispose();
      canvas.remove();
      region.remove();
      input.current = null;
      renderer.current = null;
      committed.current = "";
      pendingCommit.current = null;
    };
  }, [camera, surface]);

  useEffect(() => {
    renderer.current?.setAction(action);
    input.current?.setAttribute("data-action", action);
    input.current?.setAttribute(
      "aria-description",
      `当前${player3dActionLabel[action]}。点击人物预览区域或按 Enter／空格切换动作；拖动场景旋转，滚轮或双指缩放，双击或 Home 恢复视角；方向键旋转，+／- 缩放。`,
    );
  }, [action, generation]);

  useEffect(() => {
    input.current?.setAttribute(
      "aria-label",
      `${player?.name || "Steve"} 的 3D 皮肤预览`,
    );
  }, [player?.name, generation]);

  useEffect(() => {
    const adapter = renderer.current;
    const target = surface.current;
    if (!ready || !capeReady || !adapter || !target) return;
    let active = true;
    const isCurrent = () =>
      active &&
      renderer.current === adapter &&
      currentRequest.current === request;
    const commit = async () => {
      try {
        // Resolve both textures before committing so a delayed cape never lands
        // on a different account. A missing or damaged cape leaves the skin usable.
        const [image, cape] = await Promise.all([
          decodeImage(url).catch(() => decodeImage("/assets/steve.png")),
          capeUrl
            ? decodeImage(capeUrl)
                .then((image) =>
                  image.width === 64 && image.height === 32 ? image : null,
                )
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        const fingerprint = JSON.stringify([
          texturePixels(image),
          !!player?.slim && image.width === image.height,
          cape ? texturePixels(cape) : "",
        ]);
        const outgoing = document.createElement("canvas");
        outgoing.width = target.width;
        outgoing.height = target.height;
        outgoing.getContext("2d")?.drawImage(target, 0, 0);
        const notify = () => {
          if (!isCurrent()) return;
          readyCallback.current(target, () => {}, {
            mode: "3d",
            fingerprint,
            outgoing,
            capture: () => {
              const copy = document.createElement("canvas");
              copy.width = target.width;
              copy.height = target.height;
              copy.getContext("2d")?.drawImage(target, 0, 0);
              return copy;
            },
          });
        };
        if (committed.current === fingerprint) {
          notify();
          return;
        }
        adapter.loadSkin(image, !!player?.slim);
        adapter.loadCape(cape);
        committed.current = fingerprint;
        pendingCommit.current = notify;
        adapter.renderNow();
      } catch (error) {
        if (!isCurrent()) return;
        if (import.meta.env.DEV)
          console.error("3D texture commit failed", error);
        failureCallback.current();
      }
    };
    void commit();
    return () => {
      active = false;
      pendingCommit.current = null;
    };
  }, [
    request,
    url,
    ready,
    capeUrl,
    capeReady,
    revision,
    player?.slim,
    player?.uuid,
    player?.name,
    generation,
    surface,
  ]);

  return <div ref={host} className="players-3d-host" />;
}
