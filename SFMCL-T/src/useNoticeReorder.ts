import type { RefObject } from "react";
import type { HomeNoticeLayout } from "./types";
import { usePointerReorder } from "./usePointerReorder";
import type { PointerReorderOptions } from "./usePointerReorder";

export const noticeReorderOptions: PointerReorderOptions = {
  rowSelector: ".notice-list-item",
  keyAttribute: "data-notice-key",
  contentSelector: ".notice-list-content",
  allowedControl: ".notice-toggle",
  overlayClass: "notice-drag-overlay",
  draggingAttribute: "data-notice-dragging",
  animationPrefix: "sfmcl-t-notice",
  holdOnly: true,
  ready: (row) => row.dataset.noticePhase === "stable",
};

export function useNoticeReorder(
  root: RefObject<HTMLDivElement | null>,
  keys: string[],
  layout: HomeNoticeLayout,
  onReorder?: (keys: string[]) => void,
  options = noticeReorderOptions,
) {
  return usePointerReorder(root, keys, layout, options, onReorder);
}
