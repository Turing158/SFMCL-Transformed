import { expect, it } from "vitest";
import { migrateLegacyPreferences } from "./legacyPreferences";

it("retains existing views without overwriting newer preferences or unrelated data", () => {
  const values = new Map([
    ["tmcl.players.view", "gallery"],
    ["tmcl.resources.view", "grid"],
    ["sfmcl-t.resources.view", "list"],
    ["unrelated", "keep"],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  migrateLegacyPreferences(storage);
  migrateLegacyPreferences(storage);
  expect(values.get("sfmcl-t.players.view")).toBe("gallery");
  expect(values.get("sfmcl-t.resources.view")).toBe("list");
  expect(values.has("sfmcl-t.versions.view")).toBe(false);
  expect(values.get("tmcl.players.view")).toBe("gallery");
  expect(values.get("unrelated")).toBe("keep");
});
