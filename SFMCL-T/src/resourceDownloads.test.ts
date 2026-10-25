import { describe, expect, it } from "vitest";
import { compatibleResourceVersion } from "./resourceDownloads";
import type { ResourceFile, Version } from "./types";

const resource: ResourceFile = {
  id: "sodium",
  name: "Sodium",
  version: "1.0",
  date: "2026-10-16",
  gameVersions: ["1.20.1"],
  loaders: ["fabric"],
  dependencies: [],
};
const version: Version = {
  id: "My Fabric",
  version: "1.20.1",
  kind: "release",
  loader: "Fabric",
  path: "C:/Minecraft/versions/My Fabric",
  javaMajor: 17,
  icon: "",
};

describe("resource download compatibility", () => {
  it("matches the underlying game version and loader rather than the installation name", () => {
    expect(compatibleResourceVersion(resource, version, "mod")).toBe(true);
    expect(
      compatibleResourceVersion(
        resource,
        { ...version, version: "1.21.4" },
        "mod",
      ),
    ).toBe(false);
    for (const loader of ["Vanilla", "Forge", "NeoForge"])
      expect(
        compatibleResourceVersion(resource, { ...version, loader }, "mod"),
      ).toBe(false);
  });

  it("does not mistake a shader renderer for an installed mod loader", () => {
    expect(
      compatibleResourceVersion(
        { ...resource, loaders: ["iris"] },
        version,
        "shader",
      ),
    ).toBe(true);
    expect(
      compatibleResourceVersion(
        { ...resource, loaders: ["minecraft"] },
        version,
        "resourcepack",
      ),
    ).toBe(true);
  });

  it("allows unspecified compatibility metadata but excludes broken installations", () => {
    const unknown = { ...resource, gameVersions: [], loaders: [] };
    expect(compatibleResourceVersion(unknown, version, "mod")).toBe(true);
    expect(
      compatibleResourceVersion(
        unknown,
        { ...version, error: "Invalid JSON" },
        "mod",
      ),
    ).toBe(false);
  });
});
