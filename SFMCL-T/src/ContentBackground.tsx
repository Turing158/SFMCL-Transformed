import { useMemo } from "react";
import { backgroundDefaults } from "./background";
import "./background.css";

export function ContentBackground({
  image,
  opacity = backgroundDefaults.backgroundOverlayOpacity,
  blur = backgroundDefaults.backgroundBlur,
}: {
  image: string;
  opacity?: number;
  blur?: number;
}) {
  // Sliders change frequently; keep large image declarations stable between edits.
  const backgroundImage = useMemo(
    () => (image ? `url(${JSON.stringify(image)})` : undefined),
    [image],
  );
  return (
    <div className="content-background" aria-hidden="true">
      {image && (
        <div
          className="content-background-image"
          style={{
            // Large data URLs must stay out of CSS variable substitution.
            backgroundImage,
            filter: blur ? `blur(${blur}px)` : undefined,
            inset: -3 * blur,
          }}
        />
      )}
      <div
        className="content-background-overlay"
        style={{ opacity: image ? opacity / 100 : 0 }}
      />
    </div>
  );
}
