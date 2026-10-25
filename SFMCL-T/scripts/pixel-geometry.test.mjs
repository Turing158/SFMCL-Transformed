import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cornerProfiles,
  roundedMask,
  erode,
  contour,
  backgroundLayers,
} from "./lib/pixel-geometry.mjs";

// Independent circle-membership oracle at each mirrored grid-cell center.
function insideCircleCorner(x, y, width, height, { radius, grid }) {
  const r = Math.min(
    radius,
    Math.floor(Math.min(width, height) / (2 * grid)) * grid,
  );
  const dx = Math.max(
    0,
    r - (Math.floor(Math.min(x, width - 1 - x) / grid) + 0.5) * grid,
  );
  const dy = Math.max(
    0,
    r - (Math.floor(Math.min(y, height - 1 - y) / grid) + 0.5) * grid,
  );
  return dx * dx + dy * dy <= r * r;
}

function contains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j],
      [bx, by] = points[i];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
      inside = !inside;
  }
  return inside;
}

for (const [name, profile] of Object.entries(cornerProfiles)) {
  test(`${name}: circle samples are symmetric, integer pixels and scale only in the middle`, () => {
    const size = profile.radius * 2 + 8;
    const base = roundedMask(size, size, profile);
    for (const [width, height] of [
      [size, size],
      [size + 37, size + 11],
      [12, 12],
      [18, 26],
      [120, 12],
    ]) {
      const mask = roundedMask(width, height, profile);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          assert.equal(
            mask[y][x],
            insideCircleCorner(x, y, width, height, profile),
            `${width}x${height} at ${x},${y}`,
          );
          assert.equal(mask[y][x], mask[height - 1 - y][x]);
          assert.equal(mask[y][x], mask[y][width - 1 - x]);
          if (
            width >= size &&
            height >= size &&
            x < profile.radius &&
            y < profile.radius
          ) {
            assert.equal(mask[y][x], base[y][x]);
          }
        }
      }
    }
  });

  test(`${name}: inset pixels have the exact requested distance from the outside`, () => {
    const size = profile.radius * 2 + 8;
    const mask = roundedMask(size, size, profile);
    const original = structuredClone(mask);
    for (const stroke of [0, 1, 2]) {
      const inner = erode(mask, stroke);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // A point remains iff its entire Manhattan ball is inside the outline.
          let expected = true;
          for (let dy = -stroke; dy <= stroke; dy++) {
            for (let dx = -stroke; dx <= stroke; dx++) {
              if (
                Math.abs(dx) + Math.abs(dy) <= stroke &&
                !mask[y + dy]?.[x + dx]
              )
                expected = false;
            }
          }
          assert.equal(inner[y][x], expected, `stroke ${stroke} at ${x},${y}`);
        }
      }
      const points = contour(inner);
      assert.ok(points.length >= 4);
      points.forEach(([x, y], index) => {
        const [nextX, nextY] = points[(index + 1) % points.length];
        assert.ok(Number.isInteger(x) && Number.isInteger(y));
        assert.ok(
          (x === nextX) !== (y === nextY),
          "edges must be nonzero and axis aligned",
        );
      });
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          assert.equal(
            contains(points, x + 0.5, y + 0.5),
            inner[y][x],
            "polygon must preserve every raster pixel",
          );
        }
      }
    }
    assert.deepEqual(mask, original, "erosion must not mutate the source");
  });
}

test("16px pixel circle matches the reference project's published row spans", () => {
  const circle = roundedMask(16, 16, { radius: 8, grid: 1 });
  assert.deepEqual(
    circle.slice(0, 8).map((row) => row.filter(Boolean).length),
    [6, 10, 12, 14, 14, 16, 16, 16],
  );
});

test("field background layers preserve the outer contour and eroded fill at native sizes", () => {
  for (const [width, height] of [
    [24, 24],
    [280, 44],
    [140, 102],
  ]) {
    const outer = roundedMask(width, height, cornerProfiles.control);
    for (const mask of [outer, erode(outer, 2)]) {
      const rectangles = backgroundLayers(mask).map((layer) => {
        const [horizontal, vertical] = [...layer.matchAll(/- (\d+)px/g)].map(
          (match) => Number(match[1]) / 2,
        );
        return { horizontal, vertical };
      });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          assert.equal(
            rectangles.some(
              ({ horizontal, vertical }) =>
                x >= horizontal &&
                x < width - horizontal &&
                y >= vertical &&
                y < height - vertical,
            ),
            mask[y][x],
            `${width}x${height} at ${x},${y}`,
          );
        }
      }
    }
  }
});
