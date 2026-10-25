import type {
  LocalResource,
  ManifestVersion,
  Page,
  Project,
  Version,
} from "./types";

export const pageNames: Record<Page, string> = {
  home: "开始游戏",
  players: "角色管理",
  versions: "版本管理",
  resources: "资源中心",
  downloads: "下载中心",
  settings: "设置",
};

export type VersionPage = "settings" | "resources";
export type ResourceTab =
  "minecraft" | "mod" | "resourcepack" | "shader" | "datapack" | "modpack";
export const resourceTabNames: Record<ResourceTab, string> = {
  minecraft: "Minecraft",
  mod: "模组",
  resourcepack: "材质包",
  shader: "光影",
  datapack: "数据包",
  modpack: "整合包",
};
export type ResourcePage =
  | { kind: "minecraft"; version: ManifestVersion }
  | {
      kind: "project";
      project: Project;
      initialTab: "description" | "files";
      gameVersion: string;
      loader: string;
    };
export type PlayerLoginKind = "offline" | "microsoft";
export type ResourceNavigationEntry = {
  page: "resources";
  tab?: ResourceTab;
  resource?: ResourcePage;
  returnTo?: PrimaryNavigationEntry;
  detail?: never;
};
export type PrimaryNavigationEntry =
  | {
      page: Exclude<Page, "resources" | "downloads">;
      detail?: never;
      login?: never;
    }
  | { page: "players"; login: PlayerLoginKind; detail?: never }
  | ResourceNavigationEntry
  | {
      page: "versions";
      detail: {
        kind: VersionPage;
        version: Version;
        resource?: LocalResource;
      };
    };
export type NavigationEntry =
  | PrimaryNavigationEntry
  | {
      page: "downloads";
      returnTo?: PrimaryNavigationEntry;
      detail?: never;
      login?: never;
    };

export interface NavigationState {
  route: NavigationEntry;
  pages: Partial<Record<Page, NavigationEntry>>;
}

export const initialNavigation: NavigationState = {
  route: { page: "home" },
  pages: { home: { page: "home" } },
};

// Shared detail components belong to the main page that opened their chain.
export function navigationPage(entry: NavigationEntry): Page {
  while (entry.page === "resources" && entry.returnTo) entry = entry.returnTo;
  return entry.page;
}

export function pageViews(entry: NavigationEntry): NavigationEntry[] {
  const views = new Map<Page, NavigationEntry>();
  while (true) {
    if (!views.has(entry.page)) views.set(entry.page, entry);
    if (entry.page !== "resources" || !entry.returnTo) break;
    entry = entry.returnTo;
  }
  return [...views.values()];
}

export function navigateTo(
  current: NavigationState,
  next: NavigationEntry,
  sourcePage?: Page,
): NavigationState {
  // A retained page can finish its own work without leaving the visible page.
  const nextPage = navigationPage(next);
  if (sourcePage && navigationPage(current.route) !== sourcePage) {
    if (nextPage !== sourcePage) return current;
    return { ...current, pages: { ...current.pages, [nextPage]: next } };
  }
  const route = resolveNavigation(current.route, next);
  return { route, pages: { ...current.pages, [navigationPage(route)]: route } };
}

export function switchPage(
  current: NavigationState,
  page: Page,
  sourcePage?: Page,
) {
  if (sourcePage && navigationPage(current.route) !== sourcePage)
    return current;
  if (navigationPage(current.route) === page) return current;
  // Downloads retain their UI, but their back button belongs to this visit.
  if (page === "downloads") return navigateTo(current, { page });
  const saved = current.pages[page];
  if (saved) return navigateTo(current, saved);
  return navigateTo(
    current,
    page === "resources" ? { page: "resources" } : { page },
  );
}

export function resolveNavigation(
  current: NavigationEntry,
  next: NavigationEntry,
): NavigationEntry {
  if (next.page !== "downloads") return next;
  return {
    ...next,
    returnTo:
      next.returnTo ??
      (current.page === "downloads"
        ? (current.returnTo ?? { page: "home" })
        : current),
  };
}

export function entryLabel(entry: NavigationEntry) {
  if (entry.page === "resources") {
    if (entry.resource?.kind === "minecraft")
      return `${entry.resource.version.id} · 安装配置`;
    if (entry.resource?.kind === "project") return entry.resource.project.title;
    return `${resourceTabNames[entry.tab ?? "minecraft"]}资源`;
  }
  if (entry.page === "players" && entry.login)
    return entry.login === "offline" ? "离线登录" : "Microsoft 登录";
  if (!entry.detail) return pageNames[entry.page];
  if (entry.detail.kind === "resources" && entry.detail.resource)
    return entry.detail.resource.name;
  const label = entry.detail.kind === "settings" ? "游戏设置" : "本地资源";
  return `${entry.detail.version.id} · ${label}`;
}

export function pagePath(entry: NavigationEntry): NavigationEntry[] {
  if (entry.page === "downloads")
    return [...pagePath(entry.returnTo ?? { page: "home" }), entry];
  if (entry.page === "resources" && entry.resource)
    return [
      ...(entry.returnTo
        ? pagePath(entry.returnTo)
        : [{ page: "resources" as const, tab: entry.tab ?? "minecraft" }]),
      entry,
    ];
  if (entry.detail?.kind === "resources" && entry.detail.resource)
    return [
      { page: "versions" },
      {
        page: "versions",
        detail: { kind: "resources", version: entry.detail.version },
      },
      entry,
    ];
  return entry.detail || (entry.page === "players" && entry.login)
    ? [{ page: entry.page }, entry]
    : [entry];
}
