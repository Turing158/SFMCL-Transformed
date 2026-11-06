import { expect } from "@playwright/test";

// Sample the moving surface, not the viewport: shrinking can leave transparent
// viewport corners even when the surface itself has regressed to a rectangle.
export async function assertSurfaceCorners(page, selector, path) {
  const bounds = await page.locator(selector).boundingBox();
  const png = await page.screenshot({ path, omitBackground: true });
  const pixels = await page.evaluate(
    async ({ png, bounds }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const scale = image.width / innerWidth;
      const rgba = (x, y) =>
        context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1)
          .data;
      const alpha = (x, y) => rgba(x, y)[3];
      const { x, y, width, height } = bounds;
      const chrome = getComputedStyle(document.querySelector(".sidebar"))
        .backgroundColor.match(/\d+/g)
        .slice(0, 3)
        .map(Number);
      // Inspect actual edge colors, not just transparency: a pale backdrop can
      // bleed through antialiasing while all four corner pixels stay transparent.
      const colorDrift = [];
      for (const [flipX, flipY] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ]) {
        let drift = 0;
        for (let row = 0; row < 12; row++) {
          for (let column = 0; column < 12; column++) {
            const pixel = rgba(
              flipX ? x + width - column - 1 : x + column,
              flipY ? y + height - row - 1 : y + row,
            );
            // Very low alpha amplifies 8-bit color rounding when unpremultiplied.
            if (pixel[3] < 64) continue;
            drift = Math.max(
              drift,
              ...chrome.map((channel, index) =>
                Math.abs(channel - pixel[index]),
              ),
            );
          }
        }
        colorDrift.push(drift);
      }
      return {
        colorDrift,
        corners: [
          alpha(x + 1, y + 1),
          alpha(x + width - 2, y + 1),
          alpha(x + 1, y + height - 2),
          alpha(x + width - 2, y + height - 2),
        ],
        edges: [
          alpha(x + 12, y + 1),
          alpha(x + width - 13, y + 1),
          alpha(x + 12, y + height - 2),
          alpha(x + width - 13, y + height - 2),
        ],
      };
    },
    { png: png.toString("base64"), bounds },
  );
  expect(pixels.corners, `${selector}: all four surface corners`).toEqual([
    0, 0, 0, 0,
  ]);
  expect(
    pixels.edges.every((alpha) => alpha > 0),
    "surface edges are painted",
  ).toBe(true);
  expect(
    pixels.colorDrift.every((drift) => drift <= 8),
    `${selector}: rounded edges match the chrome without a pale halo: ${pixels.colorDrift}`,
  ).toBe(true);
}
