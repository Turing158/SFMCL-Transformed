import type { HolidayConfig } from "./types";

export interface HolidayOverlay {
  update(config: HolidayConfig): void;
  dispose(): void;
}
export function mountHolidayOverlay(
  config: HolidayConfig,
  options?: {
    notify?: (message: string) => void;
    onSurrender?: () => void;
    onUnlock?: () => void;
    onCapabilities?: (value: {
      tabs: boolean;
      tabIcons: boolean;
      menu: boolean;
    }) => void;
    manageGreeting?: boolean;
  },
): HolidayOverlay;
