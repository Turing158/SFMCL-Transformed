const SVG = "http://www.w3.org/2000/svg";
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (value: number) => 1 - (1 - clamp(value)) ** 3;
const easeInk = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

export type StartupIconPhase =
  "intro" | "draw" | "finalDraw" | "hold" | "erase" | "gap" | "complete";

interface MarkStroke {
  ink: SVGPathElement;
  mask: SVGPathElement;
  shadow: SVGPathElement;
  bed: SVGPathElement;
  nib: SVGCircleElement;
  length: number;
  start: number;
  end: number;
  eraseStart: number;
  stem: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
  parent: Element,
) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, String(value));
  parent.append(node);
  return node;
}

let serial = 0;

// Shares the startup controller's clock, including background suspension and
// the final draw. The original icon stays the source for the letter's texture.
export class StartupIconMark {
  private readonly element: SVGSVGElement;
  private readonly surface: SVGGElement;
  private readonly maskSurface: SVGGElement;
  private readonly gleam: SVGRectElement;
  private readonly strokes: MarkStroke[];

  constructor(host: HTMLElement, iconSource: string) {
    const prefix = `startup-icon-t-${++serial}`;
    this.element = svg(
      "svg",
      {
        class: "startup-icon-t",
        viewBox: "0 0 104 104",
        "aria-hidden": "true",
        focusable: "false",
      },
      host,
    );
    const defs = svg("defs", {}, this.element);
    const bed = svg("g", { class: "startup-icon-t-bed" }, this.element);
    this.surface = svg("g", {}, this.element);
    const mask = svg(
      "mask",
      {
        id: `${prefix}-mask`,
        maskUnits: "userSpaceOnUse",
        x: -10,
        y: -10,
        width: 130,
        height: 140,
        "mask-type": "luminance",
      },
      defs,
    );
    this.maskSurface = svg("g", {}, mask);

    this.strokes = [
      { name: "left", d: "M30 41H52", start: 220, end: 650, eraseStart: 0 },
      { name: "right", d: "M74 41H52", start: 220, end: 650, eraseStart: 0 },
      { name: "stem", d: "M52 41V80", start: 700, end: 1110, eraseStart: 180 },
    ].map(({ name, d, start, end, eraseStart }) => {
      const geometry = {
        d,
        fill: "none",
        "stroke-width": 8,
        "stroke-linecap": "square",
        "stroke-linejoin": "miter",
      };
      const shadow = svg(
        "path",
        {
          ...geometry,
          stroke: "#0b304f",
          opacity: 0.4,
          transform: "translate(0 1)",
        },
        bed,
      );
      const trace = svg(
        "path",
        { ...geometry, stroke: "#68a3ca", opacity: 0.24 },
        bed,
      );
      const ink = svg(
        "path",
        {
          ...geometry,
          stroke: "#b9ddee",
          class: "startup-icon-t-stroke",
          "data-stroke": name,
        },
        this.surface,
      );
      const maskPath = svg(
        "path",
        { ...geometry, stroke: "white" },
        this.maskSurface,
      );
      const length = ink.getTotalLength();
      for (const path of [ink, maskPath, shadow, trace]) {
        path.style.strokeDasharray = `${length} ${length}`;
        path.style.strokeDashoffset = String(length);
        path.style.visibility = "hidden";
      }
      const nib = svg(
        "circle",
        { r: 1.7, fill: "#dcf3ff", opacity: 0, "data-nib": name },
        this.surface,
      );
      return {
        ink,
        mask: maskPath,
        shadow,
        bed: trace,
        nib,
        length,
        start,
        end,
        eraseStart,
        stem: name === "stem",
      };
    });

    svg(
      "image",
      {
        href: iconSource,
        width: 104,
        height: 104,
        mask: `url(#${prefix}-mask)`,
        opacity: 0.3,
        class: "startup-icon-t-texture",
      },
      this.element,
    );
    const gradient = svg("linearGradient", { id: `${prefix}-gleam` }, defs);
    for (const [offset, opacity] of [
      [0, 0],
      [50, 0.9],
      [100, 0],
    ])
      svg(
        "stop",
        {
          offset: `${offset}%`,
          "stop-color": "#e8f8ff",
          "stop-opacity": opacity,
        },
        gradient,
      );
    this.gleam = svg(
      "rect",
      {
        x: -26,
        y: -12,
        width: 24,
        height: 132,
        fill: `url(#${prefix}-gleam)`,
        mask: `url(#${prefix}-mask)`,
        opacity: 0,
      },
      this.element,
    );
  }

  private progress(path: SVGPathElement, length: number, amount: number) {
    path.style.visibility = amount <= 0 ? "hidden" : "visible";
    path.style.strokeDashoffset = String(length * (1 - amount));
  }

  render(
    phase: StartupIconPhase,
    time: number,
    elapsed: number,
    transform: string,
  ) {
    const drawing =
      phase === "intro" || phase === "draw" || phase === "finalDraw";
    this.element.style.transform = transform;
    const settle = drawing
      ? -4 *
        (1 - easeOut(phase === "finalDraw" ? time / 420 : (time - 220) / 890))
      : 0;
    for (const layer of [this.surface, this.maskSurface])
      layer.setAttribute("transform", `translate(0 ${settle})`);

    for (const stroke of this.strokes) {
      // Retain the shallow engraving through waiting cycles. The compressed
      // final draw still gives the joined horizontal bar its full 50 ms pause.
      const first =
        phase === "complete"
          ? 1
          : easeInk((elapsed - stroke.start) / (stroke.end - stroke.start));
      const start =
        phase === "finalDraw" ? (stroke.stem ? 230 : 0) : stroke.start;
      const end =
        phase === "finalDraw" ? (stroke.stem ? 420 : 180) : stroke.end;
      const amount = drawing
        ? easeInk((time - start) / (end - start))
        : phase === "erase"
          ? 1 - easeInk(((time * 660) / 560 - stroke.eraseStart) / 440)
          : phase === "gap"
            ? 0
            : 1;
      this.progress(stroke.shadow, stroke.length, first);
      this.progress(stroke.bed, stroke.length, first);
      this.progress(stroke.ink, stroke.length, amount);
      this.progress(stroke.mask, stroke.length, amount);
      stroke.nib.style.opacity = "0";
      if (drawing && amount > 0 && amount < 1) {
        const point = stroke.ink.getPointAtLength(stroke.length * amount);
        stroke.nib.setAttribute("cx", String(point.x));
        stroke.nib.setAttribute("cy", String(point.y));
        stroke.nib.style.opacity = String(Math.sin(Math.PI * amount) * 0.8);
      }
    }
    // Fit the light pass into production's shorter hold, ending before erase.
    const sweepTime = phase === "hold" ? 1110 + time : time;
    const sweep =
      phase === "intro" || phase === "draw" || phase === "hold"
        ? clamp((sweepTime - 940) / 410)
        : 0;
    this.gleam.setAttribute("x", String(-26 + 156 * sweep));
    this.gleam.style.opacity = String(0.38 * Math.sin(Math.PI * sweep));
  }
}
