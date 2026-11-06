import { useLayoutEffect, useRef } from "react";
import { usePageActive } from "./PageActivity";

export function useHomeScrollPadding(showContent: boolean) {
  const content = useRef<HTMLDivElement>(null);
  const active = usePageActive();

  useLayoutEffect(() => {
    const home = content.current;
    const page = home?.closest<HTMLElement>("main");
    const card =
      page?.parentElement?.querySelector<HTMLElement>(".launch-dock-main");
    if (!home || !page || !card || !active || !showContent) {
      page?.style.removeProperty("--home-scroll-padding");
      return;
    }

    // Offset coordinates are independent of scrolling and painted motion.
    // All measured descendants have the positioned home as their ancestor.
    const bottom = (item: HTMLElement) => {
      let top = 0;
      let node: HTMLElement | null = item;
      while (node && node !== home) {
        top += node.offsetTop;
        const parent = node.offsetParent as HTMLElement | null;
        if (parent && parent !== home) top += parent.clientTop;
        node = parent;
      }
      return top + item.offsetHeight;
    };
    const measure = () => {
      const style = getComputedStyle(page);
      const base = parseFloat(style.getPropertyValue("--page-bottom-padding"));
      const dock = card.parentElement!;
      const status = dock.querySelector<HTMLElement>(".launch-status")!;
      const cover = dock.offsetHeight - status.offsetHeight;
      const end = Math.max(
        ...Array.from(
          home.querySelectorAll<HTMLElement>(
            ".page-heading, .notice-card, .notices > .helper, .notices > .inline-error, .notice-list-content > .helper",
          ),
          bottom,
        ),
        0,
      );
      const naturalEnd = home.offsetTop + end;
      const tail = Math.max(0, home.offsetHeight - end);
      const padding =
        naturalEnd > page.clientHeight - cover - 8
          ? Math.max(base, cover + 8 - tail)
          : base;
      const value = `${Math.ceil(padding)}px`;
      if (page.style.getPropertyValue("--home-scroll-padding") !== value)
        page.style.setProperty("--home-scroll-padding", value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(home);
    // Padding updates must not trigger another viewport measurement.
    observer.observe(page, { box: "border-box" });
    observer.observe(card.parentElement!, { box: "border-box" });
    return () => {
      observer.disconnect();
      page.style.removeProperty("--home-scroll-padding");
    };
  }, [active, showContent]);

  return content;
}
