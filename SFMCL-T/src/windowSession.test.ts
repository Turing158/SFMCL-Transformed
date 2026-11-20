import { describe, expect, it } from "vitest";
import { InterfaceState } from "./windowSession";

describe("interface suspension snapshots", () => {
  it("restores nested navigation and false, null and empty draft values", () => {
    const values = {
      route: {
        page: "versions",
        detail: { kind: "settings", version: { id: "1.21" } },
      },
      collapsed: false,
      draft: "",
      selection: null,
    };
    const session = new InterfaceState(values);
    expect(session.read("route", {})).toEqual(values.route);
    expect(session.read("collapsed", true)).toBe(false);
    expect(session.read("draft", "default")).toBe("");
    expect(session.read("selection", "default")).toBeNull();
  });

  it("captures the latest committed state of retained pages and removes unmounted drafts", () => {
    const session = new InterfaceState({
      "settings/tab": "game",
      "resources/query": "fabric",
    });
    let tab = session.read("settings/tab", "launcher");
    const unmount = session.register("settings/tab", () => tab);
    tab = "about";
    expect(session.capture()).toEqual({
      "settings/tab": "about",
      "resources/query": "fabric",
    });
    unmount();
    expect(session.capture()).toEqual({ "resources/query": "fabric" });
    expect(session.read("settings/tab", "launcher")).toBe("launcher");
  });

  it("does not let an old effect cleanup remove a newer registration", () => {
    const session = new InterfaceState();
    const cleanup = session.register("query", () => "first");
    session.register("query", () => "second");
    cleanup();
    expect(session.capture()).toEqual({ query: "second" });
  });
});
