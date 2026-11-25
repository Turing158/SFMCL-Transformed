import { describe, expect, it } from "vitest";
import {
  recommendedRelease,
  unresolvedConflicts,
  type PackRelease,
  type UpdatePlan,
} from "./modpackUpdate";
describe("整合包更新", () => {
  it("推荐其他正式版本，保留测试版的手动选择", () => {
    const releases = [
      { id: "beta", stable: false },
      { id: "release", stable: true },
      { id: "current", stable: true },
    ] as PackRelease[];
    expect(recommendedRelease(releases, "current")?.id).toBe("release");
    expect(
      recommendedRelease(
        [{ id: "current", stable: true }] as PackRelease[],
        "current",
      ),
    ).toBeUndefined();
  });
  it("当前已是最新版本时不把旧版本推荐为更新", () => {
    expect(
      recommendedRelease(
        [
          { id: "current", stable: true },
          { id: "old", stable: true },
        ] as PackRelease[],
        "current",
      ),
    ).toBeUndefined();
  });
  it("只有明确的文件决定才能解除冲突", () => {
    const plan = {
      items: [
        { path: "config/a", conflict: true },
        { path: "mods/b", conflict: true },
        { path: "custom/c", conflict: false },
      ],
    } as UpdatePlan;
    expect(unresolvedConflicts(plan, {})).toBe(2);
    expect(
      unresolvedConflicts(plan, { "config/a": "keep", "mods/b": "replace" }),
    ).toBe(0);
    expect(
      unresolvedConflicts(plan, { "config/a": "unknown", "custom/c": "keep" }),
    ).toBe(2);
  });
});
