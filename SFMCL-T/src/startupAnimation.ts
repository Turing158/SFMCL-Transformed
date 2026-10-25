import { StartupIconMark } from "./startupIconMark";

const SVG = "http://www.w3.org/2000/svg";
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (value: number) => 1 - (1 - clamp(value)) ** 3;
const easeInk = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const paths = [
  // S, F, M, C, L: each centerline keeps its own write/erase mask.
  "M66 28C54 16 32 16 23 29C10 48 34 50 48 53C77 59 70 82 47 84C34 85 22 81 16 74",
  "M94 82V20",
  "M94 20H140",
  "M94 49H132",
  "M168 82V20",
  "M168 20L195 58",
  "M195 58L222 20",
  "M222 20V82",
  "M304 29C292 15 270 14 257 27C242 42 242 62 256 76C269 90 291 87 304 75",
  "M334 20V82",
  "M334 82H378",
];
const durations = {
  intro: 1110,
  hold: 240,
  erase: 560,
  gap: 100,
  draw: 1110,
  finalDraw: 420,
};
type Phase = keyof typeof durations | "complete";
interface Stroke {
  ink: SVGPathElement;
  eraser: SVGPathElement;
  length: number;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, String(value));
  return node;
}

export class StartupAnimation {
  private readonly strokes: Stroke[];
  private readonly totalLength: number;
  private readonly icon: HTMLElement;
  private readonly mainIcon: HTMLImageElement;
  private readonly trails: HTMLImageElement[];
  private readonly iconMark: StartupIconMark;
  private readonly pen: SVGGElement;
  private readonly wipe: SVGGElement;
  private phase: Phase = "intro";
  private elapsed = 0;
  private phaseTime = 0;
  private frame = 0;
  private lastTime = 0;
  private loaded = false;
  private disposed = false;
  private resolveFinished!: () => void;
  readonly finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(private readonly element: HTMLElement) {
    this.icon = element.querySelector<HTMLElement>(".startup-icon")!;
    this.mainIcon =
      element.querySelector<HTMLImageElement>(".startup-icon-main")!;
    this.trails = [
      ...element.querySelectorAll<HTMLImageElement>(".startup-trail"),
    ];
    this.pen = element.querySelector<SVGGElement>(".startup-pen")!;
    this.wipe = element.querySelector<SVGGElement>(".startup-wipe")!;
    const wordmark = element.querySelector(".startup-wordmark")!;
    const masks = wordmark.querySelector("defs")!;
    const letters = wordmark.querySelector(".startup-letters")!;
    this.strokes = paths.map((d, index) => {
      const mask = svg("mask", {
        id: `startup-wipe-${index}`,
        maskUnits: "userSpaceOnUse",
        x: 0,
        y: 0,
        width: 400,
        height: 104,
        "mask-type": "luminance",
      });
      const eraser = svg("path", { d, class: "startup-erase-stroke" });
      mask.append(
        svg("rect", { width: 400, height: 104, fill: "white" }),
        eraser,
      );
      masks.append(mask);
      const ink = svg("path", {
        d,
        class: "startup-ink-stroke",
        mask: `url(#startup-wipe-${index})`,
      });
      letters.append(ink);
      const length = ink.getTotalLength();
      for (const path of [ink, eraser]) {
        path.style.strokeDasharray = `${length} ${length}`;
        path.style.strokeDashoffset = String(length);
        path.style.visibility = "hidden";
      }
      return { ink, eraser, length };
    });
    this.totalLength = this.strokes.reduce(
      (sum, stroke) => sum + stroke.length,
      0,
    );
    this.iconMark = new StartupIconMark(this.icon, this.mainIcon.src);
    this.render();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  start() {
    if (this.disposed || this.frame || this.phase === "complete") return;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  finish() {
    this.loaded = true;
    if (this.phase === "hold") this.complete();
    else if (this.phase === "gap") {
      this.phase = "finalDraw";
      this.phaseTime = 0;
    }
    return this.finished;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else this.start();
  };

  private tick = (time: number) => {
    let remaining = Math.max(0, time - this.lastTime);
    this.lastTime = time;
    while (remaining > 0 && this.phase !== "complete") {
      const step = Math.min(remaining, durations[this.phase] - this.phaseTime);
      this.elapsed += step;
      this.phaseTime += step;
      remaining -= step;
      if (this.phaseTime >= durations[this.phase]) {
        this.phaseTime = 0;
        this.next();
      }
    }
    this.render();
    if (this.phase !== "complete" && !this.disposed)
      this.frame = requestAnimationFrame(this.tick);
  };

  private next() {
    switch (this.phase) {
      case "intro":
      case "draw":
      case "finalDraw":
        if (this.loaded) this.complete();
        else this.phase = "hold";
        break;
      case "hold":
        this.phase = "erase";
        break;
      case "erase":
        this.phase = this.loaded ? "finalDraw" : "gap";
        break;
      case "gap":
        this.phase = this.loaded ? "finalDraw" : "draw";
        break;
    }
  }

  private complete() {
    this.phase = "complete";
    cancelAnimationFrame(this.frame);
    this.render();
    this.resolveFinished();
  }

  private progress(path: SVGPathElement, length: number, progress: number) {
    const p = clamp(progress);
    path.style.visibility = p <= 0 ? "hidden" : "visible";
    path.style.strokeDashoffset = String(length * (1 - p));
  }

  private moveNib(nib: SVGGElement, stroke: Stroke, progress: number) {
    const distance = stroke.length * progress;
    const point = stroke.ink.getPointAtLength(distance);
    const before = stroke.ink.getPointAtLength(Math.max(0, distance - 1));
    const after = stroke.ink.getPointAtLength(
      Math.min(stroke.length, distance + 1),
    );
    const angle =
      (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
    nib.setAttribute(
      "transform",
      `translate(${point.x} ${point.y}) rotate(${angle})`,
    );
    nib.style.opacity = String(Math.sin(Math.PI * progress) * 0.8);
  }

  private renderInk(
    mode: "draw" | "erase" | "full" | "empty",
    elapsed = 0,
    duration = 800,
  ) {
    this.pen.style.opacity = this.wipe.style.opacity = "0";
    const gap = mode === "erase" ? 7 : 12;
    const travel = Math.max(1, duration - gap * (this.strokes.length - 1));
    let start = 0;
    for (const stroke of this.strokes) {
      const duration = (travel * stroke.length) / this.totalLength;
      const raw = clamp((elapsed - start) / duration);
      const progress = easeInk(raw);
      this.progress(
        stroke.ink,
        stroke.length,
        mode === "empty" ? 0 : mode === "draw" ? progress : 1,
      );
      this.progress(
        stroke.eraser,
        stroke.length,
        mode === "erase" ? progress : 0,
      );
      if ((mode === "draw" || mode === "erase") && raw > 0 && raw < 1)
        this.moveNib(mode === "draw" ? this.pen : this.wipe, stroke, progress);
      start += duration + gap;
    }
  }

  private render() {
    const elapsed = this.phase === "complete" ? 1110 : this.elapsed;
    const progress = easeOut(elapsed / 520);
    this.icon.style.opacity = String(0.12 + 0.88 * easeOut(elapsed / 420));
    this.mainIcon.style.transform = `rotate(${-90 * (1 - progress)}deg) scale(${0.8 + 0.2 * progress})`;
    this.trails.forEach((trail, index) => {
      const past = easeOut(Math.max(0, elapsed - (4 - index) * 44) / 520);
      trail.style.transform = `rotate(${-90 * (1 - past)}deg) scale(${0.8 + 0.2 * past})`;
      trail.style.opacity = String(
        elapsed >= 700
          ? 0
          : [0.08, 0.13, 0.2, 0.29][index] * Math.min(1, (progress - past) * 5),
      );
    });
    if (this.phase === "intro" || this.phase === "draw")
      this.renderInk("draw", this.phaseTime - 140, 800);
    else if (this.phase === "finalDraw")
      this.renderInk("draw", this.phaseTime, durations[this.phase]);
    else if (this.phase === "erase")
      this.renderInk("erase", this.phaseTime, 560);
    else if (this.phase === "gap") this.renderInk("empty");
    else this.renderInk("full");
    this.iconMark.render(
      this.phase,
      this.phaseTime,
      elapsed,
      this.mainIcon.style.transform,
    );
    this.element.dataset.phase = this.phase;
  }
}
