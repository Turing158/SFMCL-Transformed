// Rasterize a circle at cell centers, then mirror its quadrant. Coordinates are
// integer CSS pixels; stretching only the middle of the rectangle preserves corners.
export const cornerProfiles = {
  micro: { radius: 2, grid: 1 },
  badge: { radius: 4, grid: 1 },
  menu: { radius: 8, grid: 2 },
  control: { radius: 12, grid: 3 },
  card: { radius: 16, grid: 4 },
  feature: { radius: 24, grid: 2 },
};

export function roundedMask(width, height, { radius, grid }) {
  const r = Math.min(
    radius,
    Math.floor(Math.min(width, height) / (2 * grid)) * grid,
  );
  const cells = r / grid;
  return Array.from({ length: height }, (_, y) => {
    const row = Math.floor(Math.min(y, height - 1 - y) / grid);
    const dy = cells - row - 0.5;
    const inset =
      row < cells
        ? Math.round(cells - Math.sqrt(cells * cells - dy * dy)) * grid
        : 0;
    return Array.from(
      { length: width },
      (_, x) => x >= inset && x < width - inset,
    );
  });
}

// Four-neighbour erosion: every removed layer is exactly one pixel of Manhattan
// distance from the outside. Unlike a second smaller circle, this cannot leave
// thin shoulders, detached corner pixels, or gaps in the border.
export function erode(mask, thickness) {
  let result = mask;
  for (let layer = 0; layer < thickness; layer++) {
    result = result.map((row, y) =>
      row.map((filled, x) =>
        Boolean(
          filled &&
          result[y - 1]?.[x] &&
          result[y + 1]?.[x] &&
          row[x - 1] &&
          row[x + 1],
        ),
      ),
    );
  }
  return result;
}

// Trace row spans clockwise, then remove collinear vertices (no diagonal edges).
export function contour(mask) {
  const rows = mask.flatMap((row, y) => {
    const left = row.indexOf(true);
    return left < 0 ? [] : [{ y, left, right: row.lastIndexOf(true) + 1 }];
  });
  if (!rows.length) return [];
  const points = [];
  for (const { y, right } of rows) points.push([right, y], [right, y + 1]);
  for (const { y, left } of rows.toReversed())
    points.push([left, y + 1], [left, y]);
  const unique = points.filter(
    (p, i) => !i || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1],
  );
  return unique.filter((p, i) => {
    const a = unique[(i + unique.length - 1) % unique.length];
    const b = unique[(i + 1) % unique.length];
    return !(
      (a[0] === p[0] && p[0] === b[0]) ||
      (a[1] === p[1] && p[1] === b[1])
    );
  });
}

export function polygon(mask, inset = 0, percentage = false) {
  const height = mask.length - 2 * inset;
  const width = mask[0].length - 2 * inset;
  const coordinate = (value, size) =>
    percentage
      ? `${Number(((value / size) * 100).toFixed(6))}%`
      : value <= size / 2
        ? `${value}px`
        : `calc(100% - ${size - value}px)`;
  return `polygon(${contour(mask)
    .map(
      ([x, y]) =>
        `${coordinate(x - inset, width)} ${coordinate(y - inset, height)}`,
    )
    .join(", ")})`;
}

export function frameSvg(mask, thickness, color) {
  const path = (shape) =>
    `M${contour(shape)
      .map((p) => p.join(" "))
      .join("L")}Z`;
  const width = mask[0].length;
  const height = mask.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><path fill="${color}" fill-rule="evenodd" d="${path(mask)} ${path(erode(mask, thickness))}"/></svg>`;
}

// Background rectangles use the same spans as the border SVG. Native inputs do
// not support decorative children; these layers leave corners transparent without
// clipping their focus ring, shadow, selection, or a popup's scrolling contents.
export function backgroundLayers(mask) {
  const groups = [];
  mask.forEach((row, y) => {
    const inset = row.indexOf(true);
    const previous = groups.at(-1);
    if (previous?.inset === inset) previous.bottom = y + 1;
    else groups.push({ inset, top: y, bottom: y + 1 });
  });
  const half = (mask.length - 1) / 2;
  return groups
    .filter((g) => g.inset >= 0 && g.top <= half)
    .map((g) => `calc(100% - ${g.inset * 2}px) calc(100% - ${g.top * 2}px)`);
}
