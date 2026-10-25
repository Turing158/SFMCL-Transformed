import {
  FlyingAnimation,
  RunningAnimation,
  SkinViewer,
  WalkingAnimation,
  WaveAnimation,
} from "skinview3d";
import { LinearSRGBColorSpace } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BufferGeometry, Material, Mesh } from "three";
import type { CameraPose } from "./playerPreview";
import type { Player3DAction } from "./player3dActions";

// Diagnostics are available only in development, never in the product UI.
export const diagnostics = {
  created: 0,
  disposed: 0,
  active: 0,
  renders: 0,
  pending: 0,
  postprocessingReleased: 0,
  maxActive: 0,
};
if (import.meta.env.DEV) {
  Object.assign(window, { __player3d: diagnostics });
}

const initialPose: CameraPose = { theta: 0.32, phi: Math.PI / 2, distance: 53 };
const minDistance = 47;
const maxDistance = 70;
const minPolarAngle = Math.PI / 3;
const maxPolarAngle = (Math.PI * 2) / 3;

export class Player3DRenderer {
  readonly viewer: SkinViewer;
  private readonly controls: OrbitControls;
  private disposed = false;
  private task: number | undefined;
  private lastRender = -Infinity;
  private animationTime: number | undefined;
  private action: Player3DAction = "still";
  private width = 0;
  private height = 0;
  private loaded = false;
  private suspended = document.hidden;
  private readonly removeListeners: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly paint: (canvas: HTMLCanvasElement) => void,
    pose?: CameraPose,
    private readonly interaction: HTMLElement = canvas,
  ) {
    // SkinViewer's constructor omits WebGLRenderer's alpha option. Acquire our
    // canvas context first so the direct-render path retains transparent pixels.
    const contextOptions = {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    };
    const context =
      canvas.getContext("webgl2", contextOptions) ||
      canvas.getContext("webgl", contextOptions);
    if (!context) throw new Error("WebGL unavailable");
    // The constructor's composer never renders. Its public dispose frees both
    // targets and the copy pass. SkinViewer.dispose owns the FXAA quad; dispose
    // its material here, leaving the quad to that method to avoid double release.
    try {
      this.viewer = new SkinViewer({
        canvas,
        width: 1,
        height: 1,
        pixelRatio: 1,
        renderPaused: true,
        preserveDrawingBuffer: false,
      });
    } catch (error) {
      const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
      context?.getExtension("WEBGL_lose_context")?.loseContext();
      throw error;
    }
    const viewer = this.viewer;
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    try {
      viewer.composer.dispose();
      viewer.renderPass.dispose();
      viewer.fxaaPass.material.dispose();
      diagnostics.postprocessingReleased++;
      // skinview3d 3.4.2 disables color management and leaves skin textures
      // untagged. Its composer renders them into a linear target. Match that
      // output when drawing directly; the renderer's default sRGB conversion
      // would brighten the skin and make dark colors look washed out.
      viewer.renderer.outputColorSpace = LinearSRGBColorSpace;
      viewer.autoRotate = false;
      viewer.animation = null;
      // The library binds controls to its render canvas. Use a separate scene
      // target without increasing the render buffer or stretching the model.
      if (interaction !== canvas) {
        viewer.controls.enabled = false;
        viewer.controls.dispose();
        this.controls = new OrbitControls(viewer.camera, interaction);
        this.removeListeners.push(() => this.controls.dispose());
      } else {
        this.controls = viewer.controls;
      }
      // Render colored skin pixels as solid surfaces. Alpha testing still
      // removes empty overlay pixels without blending clothing into the body.
      viewer.playerObject.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.material) return;
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]) {
          material.transparent = false;
          material.opacity = 1;
          material.depthWrite = true;
          material.needsUpdate = true;
        }
      });
      viewer.camera.fov = 45;
      this.controls.enablePan = false;
      this.controls.enableDamping = false;
      this.controls.autoRotate = false;
      this.controls.minDistance = minDistance;
      this.controls.maxDistance = maxDistance;
      this.controls.minPolarAngle = minPolarAngle;
      this.controls.maxPolarAngle = maxPolarAngle;
      this.controls.rotateSpeed = 0.65;
      this.controls.zoomSpeed = 0.6;
      this.setPose(pose || initialPose);
      const changed = () => this.invalidate();
      this.controls.addEventListener("change", changed);
      this.removeListeners.push(() =>
        this.controls.removeEventListener("change", changed),
      );
      const visibility = () => {
        this.suspended = document.hidden;
        this.animationTime = undefined;
        if (this.suspended) this.cancel();
        else this.invalidate();
      };
      document.addEventListener("visibilitychange", visibility);
      this.removeListeners.push(() =>
        document.removeEventListener("visibilitychange", visibility),
      );
      diagnostics.created++;
      diagnostics.active++;
      diagnostics.maxActive = Math.max(
        diagnostics.maxActive,
        diagnostics.active,
      );
    } catch (error) {
      this.removeListeners.forEach((remove) => remove());
      viewer.dispose();
      viewer.renderer.forceContextLoss();
      throw error;
    }
  }

  private cancel() {
    if (this.task !== undefined) {
      window.clearTimeout(this.task);
      this.task = undefined;
      diagnostics.pending--;
    }
  }

  invalidate() {
    if (
      this.disposed ||
      this.suspended ||
      !this.loaded ||
      !this.width ||
      !this.height ||
      this.viewer.renderer.getContext().isContextLost() ||
      this.task !== undefined
    )
      return;
    diagnostics.pending++;
    this.task = window.setTimeout(
      () => {
        this.task = undefined;
        diagnostics.pending--;
        this.renderNow();
      },
      Math.max(0, 1000 / 30 - (performance.now() - this.lastRender)),
    );
  }

  renderNow() {
    this.cancel();
    if (
      this.disposed ||
      this.suspended ||
      !this.loaded ||
      !this.width ||
      !this.height ||
      this.viewer.renderer.getContext().isContextLost()
    )
      return false;
    const now = performance.now();
    const animation = this.viewer.animation;
    if (animation && !animation.paused) {
      // Use our capped render loop, with no elapsed hidden/zero-size time.
      const delta =
        this.animationTime === undefined
          ? 0
          : Math.min(0.1, (now - this.animationTime) / 1000);
      animation.update(this.viewer.playerObject, delta);
      this.animationTime = now;
    }
    this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
    this.lastRender = now;
    diagnostics.renders++;
    // Copy in the render task: preserveDrawingBuffer stays false. The durable 2D
    // surface also makes idle frames and View Transition snapshots reliable.
    this.paint(this.viewer.canvas);
    if (animation && !animation.paused) this.invalidate();
    return true;
  }

  setAction(action: Player3DAction) {
    if (this.disposed || this.action === action) return;
    this.action = action;
    // The public setter resets joints and body transforms when changing actions.
    this.viewer.animation =
      action === "walk"
        ? new WalkingAnimation()
        : action === "run"
          ? new RunningAnimation()
          : action === "fly"
            ? new FlyingAnimation()
            : action === "wave"
              ? new WaveAnimation()
              : null;
    this.animationTime = undefined;
    this.invalidate();
  }

  setSize(width: number, height: number) {
    if (!width || !height) {
      this.width = this.height = 0;
      this.animationTime = undefined;
      this.cancel();
      return;
    }
    this.controls.rotateSpeed = (0.65 * this.interaction.clientHeight) / height;
    const scale = Math.min(1, 512 / width, 512 / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // Never call viewer.setSize/pixelRatio after composer disposal.
    this.viewer.renderer.setSize(w, h, false);
    this.viewer.camera.aspect = width / height;
    this.viewer.camera.updateProjectionMatrix();
    this.invalidate();
  }

  loadSkin(image: HTMLImageElement, slim: boolean) {
    this.viewer.loadSkin(image, {
      model: slim && image.width === image.height ? "slim" : "default",
    });
    this.loaded = true;
  }

  loadCape(image: HTMLImageElement | null) {
    if (image) this.viewer.loadCape(image, { backEquipment: "cape" });
    else this.viewer.resetCape();
  }

  getPose(): CameraPose {
    return {
      theta: this.controls.getAzimuthalAngle(),
      phi: this.controls.getPolarAngle(),
      distance: this.viewer.camera.position.distanceTo(this.controls.target),
    };
  }

  private setPose(pose: CameraPose) {
    const phi = Math.max(minPolarAngle, Math.min(maxPolarAngle, pose.phi));
    const distance = Math.max(
      minDistance,
      Math.min(maxDistance, pose.distance),
    );
    const { camera } = this.viewer;
    const controls = this.controls;
    camera.position
      .set(
        distance * Math.sin(phi) * Math.sin(pose.theta),
        distance * Math.cos(phi),
        distance * Math.sin(phi) * Math.cos(pose.theta),
      )
      .add(controls.target);
    controls.update();
  }

  reset() {
    this.setPose(initialPose);
    this.invalidate();
  }

  key(key: string) {
    const pose = this.getPose();
    switch (key) {
      case "ArrowLeft":
        pose.theta -= 0.12;
        break;
      case "ArrowRight":
        pose.theta += 0.12;
        break;
      case "ArrowUp":
        pose.phi -= 0.08;
        break;
      case "ArrowDown":
        pose.phi += 0.08;
        break;
      case "+":
      case "=":
        pose.distance /= 1.08;
        break;
      case "-":
      case "_":
        pose.distance *= 1.08;
        break;
      case "Home":
        this.reset();
        return true;
      default:
        return false;
    }
    this.setPose(pose);
    this.invalidate();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.removeListeners.forEach((remove) => remove());
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    this.viewer.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) {
        for (const material of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material])
          materials.add(material);
      }
    });
    // Viewer owns and resets its skin/cape/ears/background textures. Only dispose
    // the remaining instance-owned model geometries and materials ourselves.
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.viewer.dispose();
    this.viewer.renderer.forceContextLoss();
    diagnostics.disposed++;
    diagnostics.active--;
  }
}
