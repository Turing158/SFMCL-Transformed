import type { Player } from "./types";
import type { RefObject } from "react";

export type PlayerPreviewMode = "front" | "back" | "3d";
export const previewModeLabel = { front: "正面", back: "背面", "3d": "3D" };
export const nextPreviewMode = (mode: PlayerPreviewMode): PlayerPreviewMode =>
  mode === "front" ? "back" : mode === "back" ? "3d" : "front";

export interface PreviewFrame {
  mode: PlayerPreviewMode;
  capture: () => HTMLCanvasElement;
  fingerprint: string;
  outgoing?: HTMLCanvasElement;
}
export type PreviewReady = (
  canvas: HTMLCanvasElement,
  draw: () => void,
  frame?: PreviewFrame,
) => void;

export interface SkinPreview3DProps {
  player?: Player;
  onReady: PreviewReady;
  onFailure: (canvas?: HTMLCanvasElement) => void;
  camera: { current: CameraPose | undefined };
  surface: RefObject<HTMLCanvasElement | null>;
}
export interface CameraPose {
  theta: number;
  phi: number;
  distance: number;
}
