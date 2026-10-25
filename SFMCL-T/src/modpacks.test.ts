import { describe, expect, it } from "vitest";
import { modpackName, modpackNameError } from "./modpacks";
describe("pack instance names", () => {
  it("builds usable defaults from platform titles", () => {
    expect(modpackName("探索 / Adventure", "1.0")).toBe("探索 _ Adventure 1.0");
    expect(modpackName("CON")).toBe("整合包");
    expect(modpackName("Pack.")).toBe("Pack");
  });
  it("rejects paths, reserved names, blank and trailing characters", () => {
    for (const value of [
      "",
      "..",
      "../Pack",
      "C:\\Pack",
      "CON.zip",
      "Pack.",
      "Pack ",
    ])
      expect(modpackNameError(value)).not.toBe("");
    expect(modpackNameError("探索整合包 1.0")).toBe("");
  });
});
