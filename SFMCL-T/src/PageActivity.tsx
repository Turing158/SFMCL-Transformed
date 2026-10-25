import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Page } from "./types";

const PageActivityContext = createContext(true);

export function usePageActive() {
  return useContext(PageActivityContext);
}

export function PageActivity({
  page,
  view = page,
  active,
  children,
}: {
  page: Page;
  view?: Page;
  active: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const positions = useRef(
    new Map<HTMLElement, { top: number; left: number }>(),
  );

  useLayoutEffect(() => {
    if (!active) return;
    for (const [element, position] of positions.current) {
      if (!root.current?.contains(element)) {
        positions.current.delete(element);
        continue;
      }
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }, [active]);

  return (
    <PageActivityContext.Provider value={active}>
      <main
        ref={root}
        data-page={page}
        data-view={view}
        className={active ? "page" : undefined}
        hidden={!active}
        inert={!active}
        onScrollCapture={(event) => {
          if (!active || !(event.target instanceof HTMLElement)) return;
          const element = event.target;
          positions.current.set(element, {
            top: element.scrollTop,
            left: element.scrollLeft,
          });
        }}
      >
        {children}
      </main>
    </PageActivityContext.Provider>
  );
}
