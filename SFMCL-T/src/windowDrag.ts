import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";

const controls = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[draggable='true']",
  ...[
    "button",
    "link",
    "combobox",
    "listbox",
    "menu",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "tab",
    "tablist",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
    "scrollbar",
  ].map((role) => `[role='${role}']`),
].join(",");

// Scrollbar tracks are native controls even though their event target is the
// scroll container. Use layout coordinates so page animations do not shift them.
function onScrollbar(element: HTMLElement, x: number, y: number) {
  if (
    element.scrollHeight <= element.clientHeight &&
    element.scrollWidth <= element.clientWidth
  )
    return false;
  const bounds = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return false;
  const localX = ((x - bounds.left) * element.offsetWidth) / bounds.width;
  const localY = ((y - bounds.top) * element.offsetHeight) / bounds.height;
  const style = getComputedStyle(element);
  return (
    (element.scrollHeight > element.clientHeight &&
      ((localX >= element.clientLeft + element.clientWidth &&
        localX < element.offsetWidth - parseFloat(style.borderRightWidth)) ||
        (localX >= parseFloat(style.borderLeftWidth) &&
          localX < element.clientLeft))) ||
    (element.scrollWidth > element.clientWidth &&
      localY >= element.clientTop + element.clientHeight &&
      localY < element.offsetHeight - parseFloat(style.borderBottomWidth))
  );
}

export function canDragWindowFrom(target: Element, x: number, y: number) {
  for (
    let element: Element | null = target;
    element;
    element = element.parentElement
  ) {
    if (
      element.matches(controls) ||
      element.matches(
        "[data-window-drag='false'], [data-tauri-drag-region='false']",
      )
    )
      return false;
    if (!(element instanceof HTMLElement)) continue;
    if (onScrollbar(element, x, y)) return false;
    if (element instanceof HTMLDialogElement) {
      const bounds = element.getBoundingClientRect();
      // The backdrop closes the dialog; only its interior can move the window.
      if (
        x < bounds.left ||
        x > bounds.right ||
        y < bounds.top ||
        y > bounds.bottom
      )
        return false;
      continue;
    }
    // React also installs onclick on non-button elements with click handlers.
    // Keep clickable cards and any future custom controls working without
    // having to enumerate their styles or component names here.
    if (
      element.onclick ||
      element.onmousedown ||
      element.ondblclick ||
      element.oncontextmenu
    )
      return false;
    // React's mount container has its own delegated onclick listener; it is
    // outside the application's actual interaction surface.
    if (element.classList.contains("app")) return true;
  }
  return true;
}

export function handleWindowDrag(
  event: ReactMouseEvent<HTMLElement>,
  reportError: (message: string) => void,
) {
  if (
    !desktop ||
    event.defaultPrevented ||
    event.button !== 0 ||
    (event.detail !== 1 && event.detail !== 2) ||
    !(event.target instanceof Element) ||
    !canDragWindowFrom(event.target, event.clientX, event.clientY)
  )
    return;

  event.preventDefault();
  // The titlebar's native Tauri listener would otherwise start the same gesture
  // a second time when this mousedown reaches document.
  event.stopPropagation();
  const maximize =
    event.detail === 2 && !!event.target.closest(".topbar, .brand");
  const window = getCurrentWindow();
  void (maximize ? window.toggleMaximize() : window.startDragging()).catch(
    (error) => reportError(String(error)),
  );
}
