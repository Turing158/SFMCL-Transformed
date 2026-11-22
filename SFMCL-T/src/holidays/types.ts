export type Holiday =
  "spring" | "dragon" | "moon" | "spooky" | "winter" | "fools";

export interface HolidayConfig {
  season: Holiday;
  bare: boolean;
  drag: boolean;
  motion: boolean;
  selectionMarker: string;
  layers: Record<"hanger" | "buttons" | "tabs" | "menus" | "edges", boolean>;
  theme: {
    name: string;
    prank?: boolean;
    lanternRow?: boolean;
    christmasRow?: boolean;
    titleMoon?: boolean;
    profileTrim?: boolean;
    avatarHat?: boolean;
    avatarHover?: boolean;
    tabFu?: boolean;
    tabPinPosition?: string;
    top?: string;
    menu?: string;
    buttons: boolean;
    banner?: boolean;
    buttonEdge?: boolean;
    menuTop: boolean;
    menuEdge: boolean;
    tabPin: boolean;
    tab: boolean;
    hanger: string | null;
  };
  defs: string;
  extras: { slot: string; html: string }[];
  art: Record<string, string>;
}
