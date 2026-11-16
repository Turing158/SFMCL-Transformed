import { describe, expect, it } from "vitest";
import { offlineLanModLoader, offlineLanVersionDetails } from "./offlineLan";

describe("offline LAN loader guidance", () => {
  it("keeps vanilla and OptiFine on the switch and offers mod guidance for loaders", () => {
    for (const loader of ["Vanilla", "OptiFine", "optifine", ""]) {
      expect(offlineLanModLoader(loader)).toBe(false);
    }
    for (const loader of [
      "Forge",
      "NeoForge",
      "Fabric",
      "Quilt",
      "LiteLoader",
    ]) {
      expect(offlineLanModLoader(loader)).toBe(true);
    }
  });

  it("uses resolved host metadata and identifies Forge when OptiFine is also installed", () => {
    const details = offlineLanVersionDetails({
      id: "custom-host",
      inheritsFrom: "1.20.1",
      libraries: [
        { name: "optifine:OptiFine:1.20.1" },
        { name: "net.minecraftforge:forge:1.20.1-47.4.0" },
      ],
    });
    expect(details).toEqual({ loader: "Forge", version: "1.20.1" });
  });
});
