import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { holidayGreetings, holidayOn, nextMidnightDelay } from "./calendar";
import type { Holiday } from "./types";

const HolidayContext = createContext<Holiday | null>(null);

export function HolidayProvider({
  children,
  date,
}: {
  children: ReactNode;
  date?: Date;
}) {
  const [current, setCurrent] = useState(() => holidayOn(new Date()));
  useEffect(() => {
    if (date) return;
    let midnight = 0;
    const refresh = () => {
      const now = new Date();
      setCurrent(holidayOn(now));
      window.clearTimeout(midnight);
      midnight = window.setTimeout(refresh, nextMidnightDelay(now));
    };
    refresh();
    // Also catch a changed system clock/timezone and resume from sleep.
    const clock = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(midnight);
      window.clearInterval(clock);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [date]);
  return (
    <HolidayContext.Provider value={date ? holidayOn(date) : current}>
      {children}
    </HolidayContext.Provider>
  );
}

export function useHoliday() {
  return useContext(HolidayContext);
}
export function useHolidayGreeting() {
  const holiday = useHoliday();
  return holiday ? holidayGreetings[holiday] : "你好";
}
