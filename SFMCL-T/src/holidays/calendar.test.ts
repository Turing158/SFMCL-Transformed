import { describe, expect, it } from "vitest";
import { holidayOn, nextMidnightDelay } from "./calendar";

describe("节日当天自动启用", () => {
  it.each([
    [2026, 2, 17, "spring"],
    [2026, 6, 19, "dragon"],
    [2026, 9, 25, "moon"],
    [2027, 2, 6, "spring"],
    [2027, 6, 9, "dragon"],
    [2027, 9, 15, "moon"],
    [2026, 4, 1, "fools"],
    [2026, 10, 31, "spooky"],
    [2026, 12, 25, "winter"],
    [2027, 4, 1, "fools"],
    [2027, 10, 31, "spooky"],
    [2027, 12, 25, "winter"],
  ] as const)(
    "%i-%i-%i 当天为 %s，前后一天恢复原界面",
    (year, month, day, expected) => {
      expect(holidayOn(new Date(year, month - 1, day, 0, 0, 0))).toBe(expected);
      expect(holidayOn(new Date(year, month - 1, day, 23, 59, 59))).toBe(
        expected,
      );
      expect(holidayOn(new Date(year, month - 1, day - 1, 12))).toBeNull();
      expect(holidayOn(new Date(year, month - 1, day + 1, 12))).toBeNull();
    },
  );
  it("闰八月十五不再次启用中秋", () => {
    expect(holidayOn(new Date(1995, 8, 9))).toBe("moon");
    expect(holidayOn(new Date(1995, 9, 9))).toBeNull();
  });
  it("非节日和无效日期没有装饰", () => {
    expect(holidayOn(new Date(2026, 10, 22))).toBeNull();
    expect(holidayOn(new Date(NaN))).toBeNull();
  });
  it("在本地午夜后重新检查，也支持跨年", () => {
    expect(nextMidnightDelay(new Date(2026, 11, 31, 23, 59, 59, 900))).toBe(
      150,
    );
    expect(nextMidnightDelay(new Date(2026, 1, 17, 12))).toBe(
      12 * 60 * 60 * 1000 + 50,
    );
  });
});
