export const footerTiming = {
  duration: 260,
  fill: "both",
} as const;

export function footerFrames(from: Keyframe, to: Keyframe): Keyframe[] {
  // Hold the exact destination for the final frames so releasing the animation
  // cannot change a fractional border, glyph position or opacity at completion.
  return [
    {
      ...from,
      offset: 0,
      easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
    },
    { ...to, offset: 0.9 },
    { ...to, offset: 1 },
  ];
}
