import { describe, expect, it } from "vitest";
import {
  initialNavigation,
  entryLabel,
  navigateTo,
  navigationPage,
  pagePath,
  pageViews,
  resolveNavigation,
  switchPage,
} from "./navigation";
import type {
  NavigationEntry,
  PrimaryNavigationEntry,
  ResourceNavigationEntry,
  ResourceTab,
} from "./navigation";
import type { Project } from "./types";

describe("retained page navigation", () => {
  const login: NavigationEntry = { page: "players", login: "offline" };
  const install: NavigationEntry = {
    page: "resources",
    tab: "minecraft",
    resource: {
      kind: "minecraft",
      version: { id: "1.20.1", type: "release", releaseTime: "", url: "" },
    },
  };

  it("restores each page's child after repeated switches", () => {
    let state = navigateTo(initialNavigation, login);
    state = navigateTo(state, install);
    for (let i = 0; i < 4; i++) {
      state = switchPage(state, "players");
      expect(state.route).toBe(login);
      expect(switchPage(state, "players")).toBe(state);
      state = switchPage(state, "resources");
      expect(state.route).toBe(install);
      state = switchPage(state, "home");
      expect(state.route).toEqual({ page: "home" });
    }
  });

  it("remembers an explicit back instead of reopening the old child", () => {
    let state = navigateTo(initialNavigation, login);
    state = navigateTo(state, { page: "players" });
    state = switchPage(state, "home");
    expect(switchPage(state, "players").route).toEqual({ page: "players" });
  });

  it("uses the current download visit's parent while retaining other pages", () => {
    let state = navigateTo(initialNavigation, install);
    state = switchPage(state, "downloads");
    expect(pagePath(state.route).at(-2)).toBe(install);
    state = switchPage(state, "players");
    state = switchPage(state, "downloads");
    expect(pagePath(state.route)).toEqual([{ page: "players" }, state.route]);
    expect(switchPage(state, "resources").route).toBe(install);
  });

  it("allows background completion to update only its own saved route", () => {
    const state = switchPage(navigateTo(initialNavigation, login), "home");
    const completed = navigateTo(state, { page: "players" }, "players");
    expect(completed.route).toBe(state.route);
    expect(switchPage(completed, "players").route).toEqual({ page: "players" });
    expect(navigateTo(state, { page: "downloads" }, "players")).toBe(state);
    expect(switchPage(state, "downloads", "players")).toBe(state);
  });

  it("lets foreground actions navigate to another page explicitly", () => {
    const state = navigateTo(initialNavigation, login);
    expect(navigateTo(state, install, "players").route).toBe(install);
    expect(switchPage(state, "downloads", "players").route.page).toBe(
      "downloads",
    );
  });
});

describe("resource dependency navigation", () => {
  const project: Project = {
    id: "sodium",
    source: "modrinth",
    title: "Sodium",
    description: "",
    author: "",
    icon: "",
    downloads: 0,
    categories: [],
    versions: [],
    website: "https://modrinth.com/mod/sodium",
    body: "",
  };
  const parent: ResourceNavigationEntry = {
    page: "resources",
    tab: "mod",
    resource: {
      kind: "project",
      project,
      initialTab: "files",
      gameVersion: "1.20.1",
      loader: "Fabric",
    },
  };
  const dependency = (
    id: string,
    tab: ResourceTab,
    returnTo: ResourceNavigationEntry,
  ): ResourceNavigationEntry => ({
    page: "resources",
    tab,
    returnTo,
    resource: {
      kind: "project",
      project: { ...project, id, title: id },
      initialTab: "files",
      gameVersion: "1.20.1",
      loader: tab === "mod" ? "Fabric" : "",
    },
  });

  it.each(["mod", "resourcepack", "shader"] as const)(
    "returns from a %s dependency to its source project with the saved filters",
    (tab) => {
      const child = dependency("dependency", tab, parent);
      expect(pagePath(child)).toEqual([
        { page: "resources", tab: "mod" },
        parent,
        child,
      ]);
      expect(pagePath(child).at(-2)).toBe(parent);
      expect(resolveNavigation(child, parent)).toBe(parent);
      expect(parent.resource).toMatchObject({
        initialTab: "files",
        gameVersion: "1.20.1",
        loader: "Fabric",
      });
    },
  );

  it("returns through multiple dependencies and retains the chain when visiting downloads", () => {
    const child = dependency("Fabric API", "mod", parent);
    const grandchild = dependency("Faithful", "resourcepack", child);
    expect(pagePath(grandchild)).toEqual([
      { page: "resources", tab: "mod" },
      parent,
      child,
      grandchild,
    ]);
    const downloads = resolveNavigation(grandchild, { page: "downloads" });
    expect(pagePath(downloads).at(-2)).toBe(grandchild);
    expect(pagePath(pagePath(downloads).at(-2)!).at(-2)).toBe(child);
    expect(pagePath(child).at(-2)).toBe(parent);
    expect(pagePath(parent).at(-2)).toEqual({ page: "resources", tab: "mod" });
  });
});

describe("local resource detail navigation", () => {
  const parent: NavigationEntry = {
    page: "versions",
    detail: {
      kind: "resources",
      version: {
        id: "1.20.1-Fabric",
        version: "1.20.1",
        kind: "release",
        loader: "Fabric",
        path: "C:/Minecraft/versions/1.20.1-Fabric",
        javaMajor: 17,
        icon: "",
      },
    },
  };
  const child: NavigationEntry = {
    ...parent,
    detail: {
      ...parent.detail,
      resource: {
        name: "Sodium",
        path: `${parent.detail.version.path}/mods/sodium.jar`,
        kind: "mod",
        description: "",
        version: "0.5.11",
        authors: "CaffeineMC",
        icon: "",
        disabled: false,
        size: 2048,
        details: {},
      },
    },
  };

  it("returns from the named resource to its own version's list", () => {
    expect(pagePath(child)).toEqual([{ page: "versions" }, parent, child]);
    expect(entryLabel(child)).toBe("Sodium");
    expect(entryLabel(pagePath(child).at(-2)!)).toBe(
      "1.20.1-Fabric · 本地资源",
    );
  });

  it.each(["modrinth", "curseforge"])(
    "returns from a %s project through the local mod detail to its list",
    (source) => {
      const project: ResourceNavigationEntry = {
        page: "resources",
        tab: "mod",
        returnTo: child,
        resource: {
          kind: "project",
          project: {
            id: "sodium",
            source,
            title: "Sodium",
            description: "",
            author: "",
            icon: "",
            downloads: 0,
            categories: [],
            versions: [],
            website: "",
            body: "",
          },
          initialTab: "description",
          gameVersion: "1.20.1",
          loader: "Fabric",
        },
      };
      expect(pagePath(project)).toEqual([
        { page: "versions" },
        parent,
        child,
        project,
      ]);
      expect(resolveNavigation(project, child)).toBe(child);
      expect(pagePath(child).at(-2)).toEqual(parent);
      const downloads = resolveNavigation(project, { page: "downloads" });
      expect(pagePath(downloads)).toEqual([
        { page: "versions" },
        parent,
        child,
        project,
        downloads,
      ]);

      const catalog: NavigationEntry = { page: "resources", tab: "shader" };
      const unvisited = navigateTo(
        navigateTo(initialNavigation, child),
        project,
        "versions",
      );
      expect(unvisited.pages.resources).toBeUndefined();
      expect(switchPage(unvisited, "resources").route).toEqual({
        page: "resources",
      });
      expect(navigationPage(catalog)).toBe("resources");
      let state = navigateTo(navigateTo(initialNavigation, catalog), child);
      state = navigateTo(state, project, "versions");
      expect(navigationPage(state.route)).toBe("versions");
      expect(state.pages.resources).toBe(catalog);
      expect(state.pages.versions).toBe(project);
      expect(pageViews(project)).toEqual([project, child]);
      expect(switchPage(state, "versions")).toBe(state);
      state = switchPage(state, "resources");
      expect(state.route).toBe(catalog);
      expect(switchPage(state, "versions").route).toBe(project);

      const dependency: ResourceNavigationEntry = {
        ...project,
        returnTo: project,
      };
      // A completion while Versions is hidden updates only its own chain.
      state = navigateTo(state, dependency, "versions");
      expect(state.route).toBe(catalog);
      expect(state.pages.resources).toBe(catalog);
      expect(state.pages.versions).toBe(dependency);
      expect(pageViews(dependency)).toEqual([dependency, child]);
      state = switchPage(state, "versions");
      expect(state.route).toBe(dependency);
      state = switchPage(state, "downloads");
      expect(state.route.page).toBe("downloads");
      state = navigateTo(state, pagePath(state.route).at(-2)!);
      expect(state.route).toBe(dependency);
      expect(navigationPage(state.route)).toBe("versions");
      expect(state.pages.resources).toBe(catalog);
    },
  );

  it("retains the detail through page switches and a download visit", () => {
    let state = navigateTo(initialNavigation, child);
    state = switchPage(state, "home");
    state = switchPage(state, "versions");
    expect(state.route).toBe(child);
    const downloads = resolveNavigation(state.route, { page: "downloads" });
    expect(pagePath(downloads)).toEqual([
      { page: "versions" },
      parent,
      child,
      downloads,
    ]);
  });

  it("remembers returning to the list rather than reopening the resource", () => {
    let state = navigateTo(initialNavigation, child);
    state = navigateTo(state, pagePath(child).at(-2)!);
    state = switchPage(state, "home");
    expect(switchPage(state, "versions").route).toEqual(parent);
  });
});

describe("download navigation", () => {
  const parents: PrimaryNavigationEntry[] = [
    { page: "home" },
    { page: "players" },
    { page: "versions" },
    { page: "resources", tab: "mod" },
    { page: "settings" },
    { page: "players", login: "microsoft" },
    {
      page: "resources",
      tab: "minecraft",
      resource: {
        kind: "minecraft",
        version: { id: "1.20.1", type: "release", releaseTime: "", url: "" },
      },
    },
  ];

  it.each(parents)("returns to the exact parent: %j", (parent) => {
    const downloads = resolveNavigation(parent, { page: "downloads" });
    expect(pagePath(downloads).at(-2)).toBe(parent);
    expect(pagePath(downloads)).toHaveLength(pagePath(parent).length + 1);
    expect(resolveNavigation(downloads, parent)).toBe(parent);
  });

  it("keeps the original parent on repeated download navigation", () => {
    const parent: PrimaryNavigationEntry = { page: "resources", tab: "shader" };
    let route: NavigationEntry = parent;
    for (let i = 0; i < 5; i++) {
      route = resolveNavigation(route, { page: "downloads" });
      expect(pagePath(route)).toEqual([parent, route]);
    }
  });

  it("always has a parent even when opened without navigation history", () => {
    const downloads: NavigationEntry = { page: "downloads" };
    expect(pagePath(downloads)).toEqual([{ page: "home" }, downloads]);
    expect(resolveNavigation(downloads, downloads)).toEqual({
      page: "downloads",
      returnTo: { page: "home" },
    });
  });
});
