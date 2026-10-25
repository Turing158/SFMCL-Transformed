import { useLayoutEffect, useRef } from "react";
import { navigationPage, pagePath } from "./navigation";
import type { NavigationEntry } from "./navigation";

export function useNavigationTransition(route: NavigationEntry) {
  const workspace = useRef<HTMLDivElement>(null);
  const page = navigationPage(route);
  const path = pagePath(route);
  // Ignore refreshed data and in-page tabs; only a new breadcrumb path navigates.
  const key = JSON.stringify(
    route.page === "resources" && !route.resource
      ? [page]
      : [
          page,
          path.map((entry) =>
            entry.page === "resources" && entry.resource
              ? [
                  entry.page,
                  entry.tab,
                  entry.resource.kind,
                  entry.resource.kind === "minecraft"
                    ? entry.resource.version.id
                    : [
                        entry.resource.project.source,
                        entry.resource.project.id,
                      ],
                ]
              : entry.detail
                ? [
                    entry.page,
                    entry.detail.kind,
                    entry.detail.version.path,
                    entry.detail.version.id,
                    entry.detail.resource?.path,
                  ]
                : [
                    entry.page,
                    entry.page === "players" ? entry.login : undefined,
                  ],
          ),
        ],
  );
  const depth = path.length;
  const previous = useRef({ key, page, depth, route });

  // Route payload refreshes and in-page tab changes must not cancel motion.
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { key, page, depth, route };
    if (last.key === key || !workspace.current) return;

    const returningFromDownloads =
      last.route.page === "downloads" &&
      JSON.stringify(last.route.returnTo ?? { page: "home" }) ===
        JSON.stringify(route);
    const direction =
      returningFromDownloads || (last.page === page && last.depth > depth)
        ? -1
        : 1;
    const targets = [
      { selector: ".page", distance: 24, opacity: 0.2, id: "content" },
      {
        selector: ".topbar-breadcrumb ol",
        distance: 10,
        opacity: 0.4,
        id: "path",
      },
    ];
    const animations = targets.flatMap(
      ({ selector, distance, opacity, id }) => {
        const element = workspace.current?.querySelector<HTMLElement>(selector);
        if (!element) return [];
        return [
          element.animate(
            [
              { opacity, transform: `translateX(${direction * distance}px)` },
              { opacity: 1, transform: "translateX(0)" },
            ],
            {
              id: `sfmcl-t-navigation-${id}`,
              duration: 260,
              easing: "cubic-bezier(0.22, 0.8, 0.25, 1)",
              fill: "both",
            },
          ),
        ];
      },
    );
    const cleanup = () => animations.forEach((animation) => animation.cancel());
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(cleanup);
    return cleanup;
  }, [key, page, depth]);

  return { workspace, pageKey: key };
}
