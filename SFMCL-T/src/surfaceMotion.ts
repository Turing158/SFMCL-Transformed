export interface SurfacePose {
  scale: number;
  y: number; // Percentage of the surface height, independent of window size.
  opacity: number;
}

export const visibleSurface: SurfacePose = { scale: 1, y: 0, opacity: 1 };
export const revealSurface: SurfacePose = { scale: 0.965, y: 1.25, opacity: 0 };
export const revealDuration = 150;

export function readSurfacePose(element: HTMLElement): SurfacePose {
  const style = getComputedStyle(element);
  const matrix = new DOMMatrixReadOnly(style.transform);
  return {
    scale: matrix.a,
    y: (matrix.f / Math.max(1, element.offsetHeight)) * 100,
    opacity: Number(style.opacity),
  };
}

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const mix = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

export function surfaceMotionFrames(
  from: SurfacePose,
  to: SurfacePose,
  entering: boolean,
): Keyframe[] {
  // Sample independent motion and opacity curves into a single effect so
  // interruption, native completion and cleanup always share one timeline.
  return Array.from({ length: 33 }, (_, index) => {
    const t = index / 32;
    const movement = entering ? 1 - (1 - t) ** 3 : smooth(t);
    // Entering becomes opaque before the last gentle settling movement.
    // Exiting retains its presence briefly, then dissolves as it folds away.
    const fade = entering ? smooth(t / 0.72) : smooth((t - 0.12) / 0.88);
    return {
      offset: t,
      transform: `translateY(${mix(from.y, to.y, movement)}%) scale(${mix(from.scale, to.scale, movement)})`,
      opacity: mix(from.opacity, to.opacity, fade),
    };
  });
}
