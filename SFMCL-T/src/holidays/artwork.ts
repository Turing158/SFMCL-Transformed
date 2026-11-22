import type { Holiday, HolidayConfig } from "./types";
import sprites from "./assets/sprites.svg?raw";
import asset0 from "./assets/dragon-boat-steve.svg?url";
import asset1 from "./assets/mid-autumn-chang-e-rabbit.svg?url";
import asset2 from "./assets/minecraft-jack-o-lantern-front.png?url";
import asset3 from "./assets/spring-couplet-lettering.svg?url";
import asset4 from "./assets/spring-fu-inverted.svg?url";

const assets: Record<string, string> = {
  "dragon-boat-steve.svg": asset0,
  "mid-autumn-chang-e-rabbit.svg": asset1,
  "minecraft-jack-o-lantern-front.png": asset2,
  "spring-couplet-lettering.svg": asset3,
  "spring-fu-inverted.svg": asset4,
};
function resolveAssets(html: string): string {
  return html.replace(
    /__HOLIDAY_ASSET_(.*?)__/g,
    (_token, name: string) => assets[name],
  );
}

const themes: Record<
  Holiday,
  Pick<HolidayConfig, "theme" | "extras" | "art">
> = {
  spring: {
    theme: {
      name: "春节",
      menu: "bow",
      hanger: null,
      lanternRow: true,
      profileTrim: true,
      buttons: true,
      banner: true,
      tabFu: true,
      menuTop: true,
      menuEdge: true,
      tabPin: false,
      tab: false,
    },
    extras: [
      {
        slot: "card-ribbon",
        html: '<svg viewBox="0 0 56 78" shape-rendering="crispEdges" aria-hidden="true"><g transform="translate(56 0) scale(-1 1)"><path fill="#bd5a46" d="M4 16h44v4H4z"/><path fill="#c86950" d="M47 17h6v39h-4V21h-2z"/><path fill="#d9b26a" d="M45 53h11v5H45zM46 58h3v15h-3zM52 58h3v15h-3z"/><g transform="rotate(12 36 15)"><use href="#sfmcl-holiday-bow" x="16" y="0" width="40" height="31"/></g></g></svg>',
      },
    ],
    art: {
      titleMoon: "",
      whiteFlag: "",
      profileTrim:
        '<span class="spring-profile-top"><svg viewBox="0 0 18 12" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-springProfileCorner"/></svg></span><span class="spring-profile-bottom"><svg viewBox="0 0 18 12" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-springProfileCorner"/></svg></span><span class="spring-profile-knot"><svg viewBox="0 0 16 36" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-springProfileKnot"/></svg></span>',
      avatarHat: "",
      avatarHover: "",
      selectionMarker: "",
      tabFu: '<img src="__HOLIDAY_ASSET_spring-fu-inverted.svg__" alt="">',
      lanternRow:
        '<svg viewBox="0 0 680 34" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true"><g class="row-lantern" data-size="12" data-position="22" data-drop="2"><path d="M22 0v5" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="16" y="2" width="12" height="18"/></g><g class="row-lantern" data-size="18" data-position="97" data-drop="1"><path d="M97 0v4" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="88" y="1" width="18" height="27"/></g><g class="row-lantern" data-size="14" data-position="166" data-drop="5"><path d="M166 0v8" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="159" y="5" width="14" height="21"/></g><g class="row-lantern" data-size="20" data-position="271" data-drop="0"><path d="M271 0v3" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="261" y="0" width="20" height="30"/></g><g class="row-lantern" data-size="16" data-position="382" data-drop="3"><path d="M382 0v6" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="374" y="3" width="16" height="24"/></g><g class="row-lantern" data-size="11" data-position="462" data-drop="6"><path d="M462 0v9" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="456.5" y="6" width="11" height="16.5"/></g><g class="row-lantern" data-size="17" data-position="562" data-drop="2"><path d="M562 0v5" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="553.5" y="2" width="17" height="25.5"/></g><g class="row-lantern" data-size="13" data-position="650" data-drop="4"><path d="M650 0v7" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-lantern" x="643.5" y="4" width="13" height="19.5"/></g><g class="row-firecrackers" data-size="12" data-position="60" data-drop="3"><path d="M60 0v5" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-firecrackers" x="54" y="3" width="12" height="18"/></g><g class="row-firecrackers" data-size="14" data-position="216" data-drop="2"><path d="M216 0v4" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-firecrackers" x="209" y="2" width="14" height="21"/></g><g class="row-firecrackers" data-size="10" data-position="514" data-drop="5"><path d="M514 0v7" fill="none" stroke="#bc8b46" stroke-width="1"/><use href="#sfmcl-holiday-firecrackers" x="509" y="5" width="10" height="15"/></g></svg>',
      christmasRow: "",
      buttonTop: "",
      buttonEdge:
        '<svg viewBox="0 0 168 65" preserveAspectRatio="none" aria-hidden="true"><path d="M6 8V4h35v4H6z" fill="#bd5a46"/><path d="M149 7h8v39h-5V11h-3z" fill="#c86950"/><path d="M149 44h11v5h-11zM150 49h3v13h-3zM156 49h3v13h-3z" fill="#d9b26a"/></svg>',
      couplet:
        '<svg class="couplet-paper" viewBox="0 0 154 48" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true"><path fill="#6d2823" d="M4 5h146v3h3v34h-3v4H4v-4H1V8h3z"/><path class="couplet-sheet" d="M4 2h146v3h3v34h-3v4H4v-4H1V5h3z"/><path class="couplet-fold" d="M4 5h3v34H4zM147 5h3v34h-3zM7 40h140v3H7z"/><path fill="#dd6750" d="M7 3h140v2H7zM2 8h2v28H2z"/><path class="couplet-gold" d="M28 8h98v1H28zM28 37h98v1H28z"/><path class="couplet-gold" d="M9 9h15v2H11v7H9zM14 14h10v2h-8v5h-2zM9 29h2v8h13v2H9zM14 27h2v5h8v2H14z"/><path class="couplet-light" d="M20 21h3v2h2v3h-2v2h-3v-2h-2v-3h2z"/><g transform="translate(154 0) scale(-1 1)"><path class="couplet-gold" d="M9 9h15v2H11v7H9zM14 14h10v2h-8v5h-2zM9 29h2v8h13v2H9zM14 27h2v5h8v2H14z"/><path class="couplet-light" d="M20 21h3v2h2v3h-2v2h-3v-2h-2v-3h2z"/></g><path class="couplet-light" d="M8 6h4v2H8zM142 6h4v2h-4zM8 39h4v2H8zM142 39h4v2h-4z"/><path class="couplet-focus-mark" fill="#ffe7aa" d="M5 8h2v30H5zM147 8h2v30h-2zM26 6h102v2H26zM26 39h102v2H26z"/></svg><img class="couplet-glyphs" src="__HOLIDAY_ASSET_spring-couplet-lettering.svg__" width="76" height="16" alt="">',
      tab: "",
      tabPin: "",
      menu: '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-bow"/></svg>',
      menuEdge:
        '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-stars"/></svg>',
      hanger: "",
    },
  },
  dragon: {
    theme: {
      name: "端午",
      top: "dragonBoat",
      tabPinPosition: "top-left",
      hanger: null,
      buttons: true,
      buttonEdge: false,
      menuTop: false,
      menuEdge: false,
      tabPin: true,
      tab: false,
    },
    extras: [
      {
        slot: "card-zongzi",
        html: '<svg viewBox="0 0 64 96" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-zongzi"/></svg>',
      },
    ],
    art: {
      titleMoon: "",
      whiteFlag: "",
      profileTrim: "",
      avatarHat: "",
      avatarHover: "",
      selectionMarker:
        '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" stroke="none" stroke-width="0" aria-hidden="true"><path fill="#bd5844" d="M2 1h4v2h2v4H4V5H2z"/><path fill="#559665" d="M10 1h4v4h-2v2H8V3h2z"/><path fill="#638da8" d="M1 9h4V7h3v4H6v2H1z"/><path fill="#a180a8" d="M8 7h3v2h4v4h-5v-2H8z"/><path fill="#d4af69" d="M6 5h4v5H6zM5 11h2v4H5zM9 11h2v4H9z"/><path fill="#f1d593" d="M7 6h2v2H7z"/></svg>',
      tabFu: "",
      lanternRow: "",
      christmasRow: "",
      buttonTop:
        '<img class="dragon-boat-scene" src="__HOLIDAY_ASSET_dragon-boat-steve.svg__" alt="">',
      buttonEdge: "",
      couplet: "",
      tab: "",
      tabPin:
        '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-leaves"/></svg>',
      menu: "",
      menuEdge: "",
      hanger: "",
    },
  },
  moon: {
    theme: {
      name: "中秋",
      titleMoon: true,
      top: "moonCompanions",
      tabPinPosition: "bottom-right",
      hanger: null,
      buttons: true,
      buttonEdge: false,
      menuTop: false,
      menuEdge: true,
      tabPin: true,
      tab: false,
    },
    extras: [
      {
        slot: "card-mooncake",
        html: '<svg viewBox="0 0 48 48" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-mooncake"/></svg>',
      },
      {
        slot: "profile",
        html: '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-stars"/></svg>',
      },
    ],
    art: {
      titleMoon:
        '<svg viewBox="0 0 64 64" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-titleMoonScene"/></svg>',
      whiteFlag: "",
      profileTrim: "",
      avatarHat: "",
      avatarHover: "",
      selectionMarker: "",
      tabFu: "",
      lanternRow: "",
      christmasRow: "",
      buttonTop:
        '<img class="moon-companions-scene" src="__HOLIDAY_ASSET_mid-autumn-chang-e-rabbit.svg__" alt="">',
      buttonEdge: "",
      couplet: "",
      tab: "",
      tabPin:
        '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-stars"/></svg>',
      menu: "",
      menuEdge:
        '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-stars"/></svg>',
      hanger: "",
    },
  },
  spooky: {
    theme: {
      name: "万圣节",
      top: "witch",
      menu: "witch",
      avatarHover: true,
      hanger: null,
      buttons: true,
      menuTop: true,
      menuEdge: false,
      tabPin: false,
      tab: false,
    },
    extras: [
      {
        slot: "chrome",
        html: '<svg viewBox="0 0 108 43"  aria-hidden="true"><path d="M22 0v12M76 0v22" stroke="#9b8aa2" stroke-width="1"/><use href="#sfmcl-holiday-bat" x="1" y="9" width="43" height="26"/><use href="#sfmcl-holiday-bat" x="58" y="19" width="35" height="22"/></svg>',
      },
    ],
    art: {
      titleMoon: "",
      whiteFlag: "",
      profileTrim: "",
      avatarHat: "",
      avatarHover:
        '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-pumpkinHead"/></svg>',
      selectionMarker:
        '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" stroke="none" stroke-width="0" aria-hidden="true"><use href="#sfmcl-holiday-candy"/></svg>',
      tabFu: "",
      lanternRow: "",
      christmasRow: "",
      buttonTop:
        '<svg viewBox="0 0 64 48" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-witch"/></svg>',
      buttonEdge:
        '<svg viewBox="0 0 168 65" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true"><path fill="#655178" d="M8 8h6v30h-3v6H8v7H3v-8h3V34h2zM152 9h6v28h3v9h3v7h-6v-4h-3v4h-5V36h2z"/><path fill="#9681a6" d="M10 10h2v25h-2zM8 37h2v6H8zM154 11h2v23h-2zM157 40h2v6h-2z"/><path fill="#c49a62" d="M152 12h6v3h-6z"/></svg>',
      couplet: "",
      tab: "",
      tabPin: "",
      menu: '<svg viewBox="0 0 64 48" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-witch"/></svg>',
      menuEdge: "",
      hanger: "",
    },
  },
  winter: {
    theme: {
      name: "圣诞节",
      top: "santa",
      tabPinPosition: "bottom-left",
      avatarHat: true,
      christmasRow: true,
      hanger: null,
      buttons: true,
      menuTop: false,
      menuEdge: false,
      tabPin: true,
      tab: false,
    },
    extras: [],
    art: {
      titleMoon: "",
      whiteFlag: "",
      profileTrim: "",
      avatarHat:
        '<svg viewBox="0 0 18 10" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-avatarSantaHat"/></svg>',
      avatarHover: "",
      selectionMarker: "",
      tabFu: "",
      lanternRow: "",
      christmasRow:
        '<svg viewBox="0 0 680 32" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true"><g class="row-christmas-ornament" data-kind="christmasGift" data-size="20" data-drop="4" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M24 0v6" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasGift" x="14" y="4" width="20" height="20"/></g><g class="row-christmas-ornament" data-kind="christmasSnowflake" data-size="16" data-drop="8" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M74 0v10" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasSnowflake" x="66" y="8" width="16" height="16"/></g><g class="row-christmas-ornament" data-kind="christmasStocking" data-size="16" data-drop="2" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M136 0v4" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasStocking" x="128" y="2" width="16" height="24"/></g><g class="row-christmas-ornament" data-kind="christmasCandyCane" data-size="12" data-drop="3" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M205 0v5" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasCandyCane" x="199" y="3" width="12" height="24"/></g><g class="row-christmas-ornament" data-kind="christmasGift" data-size="18" data-drop="9" style="--gift-color:#638567;--gift-light:#93ae83"><path d="M255 0v11" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasGift" x="246" y="9" width="18" height="18"/></g><g class="row-christmas-ornament" data-kind="christmasSnowflake" data-size="20" data-drop="2" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M315 0v4" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasSnowflake" x="305" y="2" width="20" height="20"/></g><g class="row-christmas-ornament" data-kind="christmasStocking" data-size="18" data-drop="1" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M366 0v3" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasStocking" x="357" y="1" width="18" height="27"/></g><g class="row-christmas-ornament" data-kind="christmasGift" data-size="22" data-drop="3" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M430 0v5" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasGift" x="419" y="3" width="22" height="22"/></g><g class="row-christmas-ornament" data-kind="christmasSnowflake" data-size="14" data-drop="10" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M479 0v12" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasSnowflake" x="472" y="10" width="14" height="14"/></g><g class="row-christmas-ornament" data-kind="christmasCandyCane" data-size="12" data-drop="2" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M548 0v4" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasCandyCane" x="542" y="2" width="12" height="24"/></g><g class="row-christmas-ornament" data-kind="christmasStocking" data-size="16" data-drop="3" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M608 0v5" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasStocking" x="600" y="3" width="16" height="24"/></g><g class="row-christmas-ornament" data-kind="christmasSnowflake" data-size="18" data-drop="6" style="--gift-color:#bd6754;--gift-light:#dd8b70"><path d="M658 0v8" fill="none" stroke="#a9956c" stroke-width="1"/><use href="#sfmcl-holiday-christmasSnowflake" x="649" y="6" width="18" height="18"/></g></svg>',
      buttonTop:
        '<svg viewBox="0 0 64 48" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-santa"/></svg>',
      buttonEdge:
        '<svg viewBox="0 0 168 65" preserveAspectRatio="none" aria-hidden="true"><path d="M4 45h154v6H4zM142 47h9v17l-4-3-5 3z" fill="#b86351"/><path d="M6 47h133v2H6zM143 55h7v3h-7z" fill="#e5b69a"/><path d="M151 6h8v3h-8z" fill="#f0eadf"/></svg>',
      couplet: "",
      tab: "",
      tabPin:
        '<svg viewBox="0 0 64 40" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-holly"/></svg>',
      menu: "",
      menuEdge: "",
      hanger: "",
    },
  },
  fools: {
    theme: {
      name: "愚人节",
      prank: true,
      hanger: null,
      buttons: false,
      buttonEdge: false,
      menuTop: false,
      menuEdge: false,
      tabPin: false,
      tab: false,
    },
    extras: [],
    art: {
      titleMoon: "",
      whiteFlag:
        '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><use href="#sfmcl-holiday-whiteFlag"/></svg>',
      profileTrim: "",
      avatarHat: "",
      avatarHover: "",
      selectionMarker: "",
      tabFu: "",
      lanternRow: "",
      christmasRow: "",
      buttonTop: "",
      buttonEdge: "",
      couplet: "",
      tab: "",
      tabPin: "",
      menu: "",
      menuEdge: "",
      hanger: "",
    },
  },
};

export function createHolidayConfig(season: Holiday): HolidayConfig {
  const theme = themes[season];
  return {
    season,
    bare: false,
    drag: false,
    motion: true,
    selectionMarker: season === "spooky" ? "candy" : "knot",
    layers: {
      hanger: true,
      buttons: true,
      tabs: true,
      menus: true,
      edges: true,
    },
    theme: theme.theme,
    defs: resolveAssets(sprites),
    extras: theme.extras.map((extra) => ({
      ...extra,
      html: resolveAssets(extra.html),
    })),
    art: Object.fromEntries(
      Object.entries(theme.art).map(([key, html]) => [
        key,
        resolveAssets(html),
      ]),
    ),
  };
}
