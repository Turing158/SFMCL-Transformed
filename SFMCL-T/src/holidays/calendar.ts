import { Solar } from "lunar-typescript";
import type { Holiday } from "./types";

// Use the device's civil date; lunar months are negative in a leap month.
export function holidayOn(date: Date): Holiday | null {
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear(),
    month = date.getMonth() + 1,
    day = date.getDate();
  if (month === 4 && day === 1) return "fools";
  if (month === 10 && day === 31) return "spooky";
  if (month === 12 && day === 25) return "winter";
  const lunar = Solar.fromYmd(year, month, day).getLunar();
  if (lunar.getMonth() === 1 && lunar.getDay() === 1) return "spring";
  if (lunar.getMonth() === 5 && lunar.getDay() === 5) return "dragon";
  if (lunar.getMonth() === 8 && lunar.getDay() === 15) return "moon";
  return null;
}

export function nextMidnightDelay(date: Date): number {
  const next = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  );
  return Math.max(1, next.getTime() - date.getTime() + 50);
}

export const holidayGreetings: Record<Holiday, string> = {
  spring: "新春快乐",
  dragon: "端午安康",
  moon: "中秋快乐",
  spooky: "万圣奇妙夜",
  winter: "圣诞快乐",
  fools: "你好",
};
