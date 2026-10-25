const paths = {
  play: "M4 1h2v2h2v2h2v2h2v2h-2v2H8v2H6v2H4z",
  switch: "M9 1h2v2h2v2h2v2H3V5h8V3H9zM7 9v2H5v2h8v2H1v-2h2v-2h2V9z",
  box: "M3 1h10v2H3zM1 3h2v10H1zm12 0h2v10h-2zM3 13h10v2H3zM3 5h10v2H9v6H7V7H3z",
  settings: "M6 1h4v2h3v3h2v4h-2v3h-3v2H6v-2H3v-3H1V6h2V3h3zm0 5v4h4V6z",
  star: "M7 1h2v4h4v2h2v2h-4v2h2v4H9v-2H7v2H3v-4h2V9H1V7h2V5h4z",
  more: "M1 6h3v3H1zm6 0h3v3H7zm6 0h3v3h-3z",
  arrow: "M5 2h2v2h2v2h2v4H9v2H7v2H5v-2h2v-2h2V6H7V4H5z",
  rename: "M10 1h3v2h-1v10h1v2h-3v-2h1V3h-1zM2 5h7v2H4v4h5v2H2z",
  folder: "M1 3h6v2h8v9H1zm2 4v5h10V7z",
  image: "M1 1h14v14H1zm2 2v10h10V3zM4 4h3v3H4zm5 4h2v2h2v2H4v-2h3V9h2z",
  refresh:
    "M2 1h2v3h6V3H6V1h6v2h2v2h2v6h-2v2h-2v2H6v-2H4v-2H2V9h2v2h2v2h6v-2h2V5h-2v1H4v2H2z",
  trash: "M5 1h6v2h3v2H2V3h3zM3 6h2v7h6V6h2v9H3zm4 1h2v5H7z",
} as const;

export function PixelMenuIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <path fill="currentColor" fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}
