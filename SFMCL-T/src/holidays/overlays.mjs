// Shared by the launcher and its design preview. Importing has no DOM side effects.
export function mountHolidayOverlay(initialConfig, options = {}) {
  const controller = new AbortController();
  const animations = new Set();
  let disposed = false,
    frame = 0;
  function listen(target, type, listener, settings = {}) {
    target.addEventListener(
      type,
      listener,
      typeof settings === "boolean"
        ? { capture: settings, signal: controller.signal }
        : { ...settings, signal: controller.signal },
    );
  }
  function animate(element, ...args) {
    const animation = element.animate(...args);
    animations.add(animation);
    void animation.finished.then(
      () => animations.delete(animation),
      () => animations.delete(animation),
    );
    return animation;
  }
  const style = document.createElement("style");
  style.textContent = `
.holiday-overlay{position:fixed;inset:0;z-index:100000;pointer-events:none;overflow:hidden;clip-path:var(--window-corner-shape)}
.holiday-node{position:absolute;pointer-events:none;user-select:none;transform-origin:center}
.holiday-node>svg,.holiday-node>img{display:block;width:100%;height:100%;overflow:visible}
.holiday-node>img{object-fit:contain;object-position:center bottom;image-rendering:pixelated}
.holiday-node.boat::before{content:'';position:absolute;left:0;right:0;bottom:0;height:calc(8px * var(--boat-scale,1));z-index:-1;background:#8fc7ca;clip-path:polygon(0 25%,12% 25%,12% 0,28% 0,28% 25%,70% 25%,70% 0,86% 0,86% 25%,100% 25%,100% 75%,calc(100% - 2px * var(--boat-scale,1)) 75%,calc(100% - 2px * var(--boat-scale,1)) 100%,calc(2px * var(--boat-scale,1)) 100%,calc(2px * var(--boat-scale,1)) 75%,0 75%)}
.holiday-couplet .couplet-paper{--couplet-red:#bb3d30;--couplet-fold:#992f29;--couplet-gold:#dfb768;--couplet-light:#f2ce83;width:100%;height:100%}.couplet-sheet{fill:var(--couplet-red)}.couplet-fold{fill:var(--couplet-fold)}.couplet-gold{fill:var(--couplet-gold)}.couplet-light{fill:var(--couplet-light)}.couplet-focus-mark{opacity:0}.holiday-couplet .couplet-glyphs{position:absolute;left:calc(50% - 38px);top:calc(50% - 8px);width:76px;height:16px;image-rendering:pixelated}
.holiday-couplet:is([data-hover=true],[data-focus=true]) .couplet-paper{--couplet-red:#cb4937;--couplet-fold:#a7372c;--couplet-gold:#f1ce81;--couplet-light:#ffe0a1}.holiday-couplet[data-focus=true] .couplet-focus-mark{opacity:1}.holiday-couplet[data-active=true] .couplet-paper{--couplet-red:#aa342b;--couplet-fold:#842822}
/* The paper replaces every native paint layer, including the hover frame. */
:root[data-holiday-banner=true] .launch-dock .launch-actions>.launch-primary{--surface-fill:transparent;--surface-edge:transparent;--surface-base:transparent;background:none;border:0;box-shadow:none;outline:none}
:root[data-holiday-banner=true] .launch-primary>:is(.surface-frame,.launch-button-surface,.launch-control-fx){visibility:hidden}
@media(prefers-reduced-motion:no-preference){.holiday-couplet .couplet-paper path{transition:fill 140ms ease,opacity 140ms ease}}
.holiday-cord{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.holiday-cord path{fill:none;stroke:#b5946b;stroke-width:1.3;stroke-dasharray:3 2}.holiday-cord circle{fill:#bd9b68;stroke:#f8f4dc;stroke-width:2}
.holiday-hanger{position:absolute;width:78px;height:116px;padding:0;border:0;background:transparent;pointer-events:auto;touch-action:none;cursor:grab;filter:drop-shadow(3px 5px 0 #29332312)}.holiday-hanger>svg{width:100%;height:100%;transform-origin:50% 3%}.holiday-hanger:focus-visible{outline:2px dashed var(--accent);outline-offset:4px}.holiday-hanger.dragging{cursor:grabbing}.holiday-overlay[data-motion=true] .holiday-hanger:not(.dragging)>svg{animation:holiday-sway 5s ease-in-out infinite}@keyframes holiday-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}@media(prefers-reduced-motion:reduce){.holiday-hanger>svg{animation:none!important}}
.holiday-hanger[data-anchor=brand]{width:34px;height:51px}
.holiday-tab-fu{display:block;position:absolute;left:0;top:50%;transform:translateY(-50%);pointer-events:none;user-select:none}.holiday-tab-fu>img{display:block;width:100%;height:100%;image-rendering:pixelated;transform-origin:center;opacity:0}
.holiday-tab-fu[hidden]{display:none}
.tab-content[data-holiday-fu-replaced=true]>:is(svg,img):first-child{visibility:hidden}
.tab-content[data-holiday-icon-entering=true]>:is(svg,img):first-child{transform-box:border-box;transform-origin:center;will-change:transform,opacity}
[data-holiday-selection-replaced=true]>:not(.holiday-selection-art){visibility:hidden}
.holiday-selection-art{pointer-events:none;shape-rendering:crispEdges}
.tab-pin-top-left>svg{transform-origin:35% 60%;opacity:0;will-change:transform,opacity}
.tab-pin-bottom-left>svg{transform-origin:35% 40%;opacity:0;will-change:transform,opacity}
.page-title-mark[data-holiday-title-moon=true]{position:relative;isolation:isolate}.page-title-mark[data-holiday-title-moon=true]>.surface-frame{visibility:hidden}.page-title-mark[data-holiday-title-moon=true]>:is(svg,img){position:relative;top:-4px;z-index:1;color:#815b2f}.holiday-title-moon{position:absolute;left:50%;top:50%;width:64px;height:64px;transform:translate(-50%,-50%);pointer-events:none;user-select:none;z-index:0}.holiday-title-moon>svg{display:block;width:100%;height:100%;overflow:visible;shape-rendering:crispEdges}
.holiday-pumpkin-avatar{position:absolute;inset:4px;pointer-events:none;opacity:0;transform:rotate(-70deg) scale(.5);transition:opacity 180ms ease,transform 220ms cubic-bezier(.22,.8,.25,1)}.holiday-pumpkin-avatar>svg{display:block;width:100%;height:100%;shape-rendering:crispEdges}
.holiday-avatar-hat{position:absolute;left:0;bottom:calc(100% - 2px);width:36px;height:20px;pointer-events:none;user-select:none;z-index:3}.holiday-avatar-hat>svg{display:block;width:100%;height:100%;shape-rendering:crispEdges}
.holiday-spring-profile{position:absolute;inset:0;pointer-events:none;user-select:none;z-index:3}.holiday-spring-profile>span{position:absolute;display:block}.holiday-spring-profile svg{display:block;width:100%;height:100%;overflow:visible;shape-rendering:crispEdges}.spring-profile-top{left:-2px;top:-2px;width:18px;height:12px}.spring-profile-bottom{left:-2px;bottom:-2px;width:18px;height:12px}.spring-profile-bottom>svg{transform:scaleY(-1)}.spring-profile-knot{right:-9px;top:-6px;width:16px;height:36px}
.sidebar .avatar[data-holiday-pumpkin-avatar=true]>canvas{opacity:1;transform:rotate(0deg) scale(1);transition:opacity 180ms ease,transform 220ms cubic-bezier(.22,.8,.25,1)}
.sidebar .profile-button:hover:not(:disabled) .avatar[data-holiday-pumpkin-avatar=true]>canvas{opacity:0;transform:rotate(70deg) scale(.5)}.sidebar .profile-button:hover:not(:disabled) .holiday-pumpkin-avatar{opacity:1;transform:rotate(0deg) scale(1)}
[data-april-original=true]{visibility:hidden!important}
[data-april-sidebar=true]{translate:var(--april-swap-x,0px) var(--april-swap-y,0px);will-change:translate}
[data-april-favorite-original=true],[data-april-favorite-original=true] *{visibility:hidden!important;pointer-events:none!important}
.holiday-prank-favorite-proxy{pointer-events:auto;z-index:2}.holiday-prank-favorite-proxy>.sidebar{all:unset;display:block;width:100%;height:100%}.holiday-prank-favorite-proxy button{width:100%!important;height:100%!important;margin:0!important}.holiday-prank-favorite-proxy[data-returning=true],.holiday-prank-favorite-proxy[data-returning=true] button{pointer-events:none}
.holiday-prank-proxy{z-index:1;pointer-events:auto}.holiday-prank-proxy>div,.holiday-prank-proxy .launch-actions{position:static;display:block;width:100%;height:100%;min-height:0;margin:0;padding:0}.holiday-prank-proxy button{width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;margin:0!important;cursor:pointer}
.holiday-prank-proxy[data-returning=true]{pointer-events:none}
.window-controls .holiday-prank-flag{overflow:hidden}.window-controls .holiday-prank-flag>svg{width:15px;height:15px;shape-rendering:crispEdges}.window-controls .holiday-prank-flag[data-phase=leaving]{pointer-events:none}
`;
  document.head.append(style);
  const defs = document.createElement("div");
  defs.className = "holiday-defs";
  defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  defs.setAttribute("aria-hidden", "true");
  const layer = document.createElement("div");
  layer.className = "holiday-overlay";
  layer.hidden = true;
  document.body.append(defs, layer);
  let config = null,
    items = [],
    drag = null,
    hanger = null,
    cord = null;
  const positions = {};
  const fuItems = new Map();
  const iconMotions = new WeakMap();
  const tabPins = new Map();
  const selectionItems = new Map();
  const pumpkinAvatars = new Map();
  const avatarHats = new Map();
  const springProfiles = new Map();
  const titleMoons = new Map();
  function removeTitleMoon(mark, node) {
    node.remove();
    delete mark.dataset.holidayTitleMoon;
    titleMoons.delete(mark);
  }
  function syncTitleMoons() {
    const marks =
      config.theme.titleMoon && config.layers.edges && !config.bare
        ? [...document.querySelectorAll(".page-title-mark")].filter((mark) =>
            [...mark.children].some((child) => child.matches("svg,img")),
          )
        : [];
    const retained = new Set(marks);
    for (const [mark, node] of titleMoons)
      if (!retained.has(mark)) removeTitleMoon(mark, node);
    for (const mark of marks) {
      if (titleMoons.get(mark)?.isConnected) continue;
      const node = document.createElement("span");
      node.className = "holiday-title-moon";
      node.setAttribute("aria-hidden", "true");
      node.innerHTML = config.art.titleMoon;
      // The native icon stays in its own title; the moon and clouds follow the mark.
      mark.append(node);
      mark.dataset.holidayTitleMoon = "true";
      titleMoons.set(mark, node);
    }
  }
  const prankItems = new Map();
  const prankSelectors =
    ".launch-dock .launch-actions>.launch-primary,.launch-dock .launch-actions>.launch-switch";
  const prankSidebarItems = new Map();
  const prankSidebarSelectors =
    ".sidebar #sidebar-navigation>button,.sidebar .sidebar-task,.sidebar .profile-button,.sidebar .sidebar-favorite";
  const prankReturnAnimations = new Set();
  const prankSidebarCleanups = new Set();
  const prankMoveEasing = "cubic-bezier(0.22,1,0.36,1)";
  let prankHoverSlot = null;
  let prankFlag = null,
    prankSurrendered = false,
    prankPointer = null,
    prankSerial = 0;
  let prankMoveCount = 0,
    prankFlagAnimation = null,
    prankFlagIconAnimation = null;
  const prankActive = () =>
    config?.theme.prank && !config.bare && !prankSurrendered;
  function recordPrankMoves(count) {
    const previousCount = prankMoveCount;
    prankMoveCount += count;
    document.documentElement.dataset.aprilMoves = String(prankMoveCount);
    if (previousCount <= 10 && prankMoveCount > 10) options.onUnlock?.();
    if (previousCount < 15 && prankMoveCount >= 15) {
      options.notify?.("放弃吧！（右上角）");
    }
  }
  function animatePrankFlag(show) {
    const button = prankFlag,
      icon = button.firstElementChild;
    const current = getComputedStyle(button),
      currentIcon = getComputedStyle(icon);
    const from = {
      width: show ? "0px" : current.width,
      opacity: show ? 0 : current.opacity,
    };
    const iconFrom = {
      transform: show ? "rotate(-90deg) scale(0.2)" : currentIcon.transform,
      opacity: show ? 0 : currentIcon.opacity,
    };
    prankFlagAnimation?.cancel();
    prankFlagIconAnimation?.cancel();
    button.dataset.phase = show ? "entering" : "leaving";
    if (!show) {
      button.tabIndex = -1;
      delete button.dataset.tooltip;
    }
    const timing = {
      duration: show ? 280 : 240,
      easing: prankMoveEasing,
      fill: "both",
    };
    const animation = animate(
      button,
      [from, { width: show ? current.width : "0px", opacity: show ? 1 : 0 }],
      timing,
    );
    const iconAnimation = animate(
      icon,
      [
        iconFrom,
        {
          transform: show
            ? "rotate(0deg) scale(1)"
            : "rotate(90deg) scale(0.2)",
          opacity: show ? 1 : 0,
        },
      ],
      timing,
    );
    prankFlagAnimation = animation;
    prankFlagIconAnimation = iconAnimation;
    void animation.finished.then(
      () => {
        if (prankFlagAnimation !== animation) return;
        prankFlagAnimation = prankFlagIconAnimation = null;
        if (show) button.dataset.phase = "active";
        else {
          button.remove();
          if (prankFlag === button) prankFlag = null;
        }
        animation.cancel();
        iconAnimation.cancel();
      },
      () => {},
    );
  }
  function removePrankSidebarItem(target, entry, animated = false) {
    const from = getComputedStyle(entry.node).translate;
    entry.animation?.cancel();
    for (const [property, saved] of [
      ["--april-swap-x", entry.originalX],
      ["--april-swap-y", entry.originalY],
    ]) {
      if (saved.value)
        entry.node.style.setProperty(property, saved.value, saved.priority);
      else entry.node.style.removeProperty(property);
    }
    delete entry.node.dataset.aprilSidebar;
    delete entry.node.dataset.aprilSlot;
    delete entry.node.dataset.aprilSwaps;
    prankSidebarItems.delete(target);
    if (
      animated &&
      from.split(/\s+/).some((value) => Math.abs(parseFloat(value) || 0) > 0.05)
    ) {
      if (entry.proxy) entry.proxy.dataset.returning = "true";
      const animation = animate(
        entry.node,
        [
          { translate: from },
          { translate: getComputedStyle(entry.node).translate },
        ],
        { duration: 360, easing: prankMoveEasing },
      );
      animation.id = "holiday-prank-sidebar-return";
      prankReturnAnimations.add(animation);
      void animation.finished.then(
        () => {
          prankReturnAnimations.delete(animation);
          animation.cancel();
          entry.restore?.();
        },
        () => {
          prankReturnAnimations.delete(animation);
          entry.restore?.();
        },
      );
    } else entry.restore?.();
  }
  function clearPrankSidebar(animated = false) {
    for (const [target, entry] of prankSidebarItems)
      removePrankSidebarItem(target, entry, animated);
    prankHoverSlot = null;
  }
  function swapPrankSidebarItem(entry) {
    const partners = [...prankSidebarItems.values()].filter(
      (other) => other !== entry,
    );
    if (!partners.length) return;
    const partner = partners[Math.floor(Math.random() * partners.length)];
    [entry.slot, partner.slot] = [partner.slot, entry.slot];
    for (const item of [entry, partner]) {
      item.swaps++;
      item.node.dataset.aprilSwaps = String(item.swaps);
    }
    recordPrankMoves(2);
  }
  function favoriteInViewport(target) {
    const viewport = target.closest(".sidebar-favorites");
    if (!viewport) return false;
    const r = target.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect();
    return r.top >= bounds.top - 0.5 && r.bottom <= bounds.bottom + 0.5;
  }
  function createPrankFavorite(target) {
    const proxy = document.createElement("span");
    proxy.className = "holiday-node holiday-prank-favorite-proxy";
    const context = document.createElement("div");
    context.className = "sidebar";
    const node = target.cloneNode(true);
    for (const child of [node, ...node.querySelectorAll("[id]")])
      child.removeAttribute("id");
    const computed = getComputedStyle(target);
    for (const property of [
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
    ]) {
      node.style.setProperty(property, computed.getPropertyValue(property));
    }
    context.append(node);
    proxy.append(context);
    layer.append(proxy);
    const originalTabIndex = target.getAttribute("tabindex"),
      originalAriaHidden = target.getAttribute("aria-hidden");
    target.dataset.aprilFavoriteOriginal = "true";
    target.setAttribute("aria-hidden", "true");
    target.tabIndex = -1;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      delete target.dataset.aprilFavoriteOriginal;
      for (const [attribute, value] of [
        ["tabindex", originalTabIndex],
        ["aria-hidden", originalAriaHidden],
      ]) {
        if (value === null) target.removeAttribute(attribute);
        else target.setAttribute(attribute, value);
      }
      proxy.remove();
      prankSidebarCleanups.delete(restore);
    };
    prankSidebarCleanups.add(restore);
    return { node, proxy, restore };
  }
  function syncPrankSidebar() {
    if (!prankActive()) {
      clearPrankSidebar();
      return;
    }
    const buttons = [
      ...document.querySelectorAll(prankSidebarSelectors),
    ].filter(
      (target) =>
        !target.disabled &&
        !target.closest(".holiday-overlay,[hidden],[inert]") &&
        target.getClientRects().length &&
        (target.dataset.aprilFavoriteOriginal === "true" ||
          getComputedStyle(target).visibility !== "hidden") &&
        (!target.classList.contains("sidebar-favorite") ||
          favoriteInViewport(target)),
    );
    const retained = new Set(buttons);
    // Scrolling favorites or hiding an entry changes the available slots.
    if ([...prankSidebarItems.keys()].some((target) => !retained.has(target)))
      clearPrankSidebar();
    for (const target of buttons) {
      if (prankSidebarItems.has(target)) continue;
      const saved = (property) => ({
        value: target.style.getPropertyValue(property),
        priority: target.style.getPropertyPriority(property),
      });
      const favorite = target.classList.contains("sidebar-favorite")
        ? createPrankFavorite(target)
        : { node: target };
      prankSidebarItems.set(target, {
        ...favorite,
        source: target,
        slot: target,
        dx: 0,
        dy: 0,
        swaps: 0,
        originalX: saved("--april-swap-x"),
        originalY: saved("--april-swap-y"),
      });
      favorite.node.dataset.aprilSidebar = "true";
      favorite.node.dataset.aprilSwaps = "0";
    }
    const entries = [...prankSidebarItems.values()];
    const bases = new Map(
      entries.map((entry) => {
        const r = entry.source.getBoundingClientRect();
        // Subtract the currently painted offset, including an in-flight animation.
        const [x = 0, y = 0] = getComputedStyle(entry.source)
          .translate.split(/\s+/)
          .map((value) => parseFloat(value) || 0);
        return [
          entry.source,
          { x: r.x - x, y: r.y - y, width: r.width, height: r.height },
        ];
      }),
    );
    if (prankPointer) {
      // Track fixed slots so passing buttons cannot retrigger the same hover.
      const hoveredSlot = [...bases].find(([, r]) => {
        return (
          prankPointer.x >= r.x &&
          prankPointer.x <= r.x + r.width &&
          prankPointer.y >= r.y &&
          prankPointer.y <= r.y + r.height
        );
      });
      if (!hoveredSlot) prankHoverSlot = null;
      else if (hoveredSlot[0] !== prankHoverSlot) {
        prankHoverSlot = hoveredSlot[0];
        swapPrankSidebarItem(
          entries.find((entry) => entry.slot === hoveredSlot[0]),
        );
      }
    }
    for (const entry of entries) {
      const own = bases.get(entry.source),
        slot = bases.get(entry.slot);
      if (entry.proxy) {
        Object.assign(entry.proxy.style, {
          left: `${own.x}px`,
          top: `${own.y}px`,
          width: `${own.width}px`,
          height: `${own.height}px`,
        });
        // Keep the copy in sync with the native favorite's selection and rail layout.
        entry.node.className = entry.source.className;
        const context = entry.proxy.firstElementChild;
        context.classList.toggle(
          "rail-collapsed",
          entry.source.closest(".sidebar").classList.contains("rail-collapsed"),
        );
        for (const property of [
          "--rail-open",
          "--rail-inset",
          "--sidebar",
          "--sidebar-tip",
        ]) {
          context.style.setProperty(
            property,
            getComputedStyle(entry.source).getPropertyValue(property),
          );
        }
      }
      const dx = slot.x + (slot.width - own.width) / 2 - own.x;
      const dy = slot.y + (slot.height - own.height) / 2 - own.y;
      if (Math.abs(dx - entry.dx) > 0.05 || Math.abs(dy - entry.dy) > 0.05) {
        const from = getComputedStyle(entry.node).translate;
        entry.animation?.cancel();
        entry.node.style.setProperty("--april-swap-x", `${dx}px`);
        entry.node.style.setProperty("--april-swap-y", `${dy}px`);
        entry.dx = dx;
        entry.dy = dy;
        const animation = animate(
          entry.node,
          [{ translate: from }, { translate: `${dx}px ${dy}px` }],
          { duration: 360, easing: prankMoveEasing, fill: "both" },
        );
        animation.id = "holiday-prank-sidebar-swap";
        entry.animation = animation;
        void animation.finished.then(
          () => {
            if (entry.animation === animation) {
              entry.animation = null;
              animation.cancel();
            }
          },
          () => {},
        );
      }
      const slotIndex = String(
        entries.findIndex((item) => item.source === entry.slot),
      );
      if (entry.node.dataset.aprilSlot !== slotIndex)
        entry.node.dataset.aprilSlot = slotIndex;
    }
  }
  function removePrankItem(target, entry) {
    entry.animation?.cancel();
    entry.node.remove();
    delete target.dataset.aprilOriginal;
    prankItems.delete(target);
  }
  function clearPrank() {
    for (const animation of prankReturnAnimations) animation.cancel();
    prankReturnAnimations.clear();
    clearPrankSidebar();
    for (const restore of prankSidebarCleanups) restore();
    for (const [target, entry] of prankItems) removePrankItem(target, entry);
    prankFlagAnimation?.cancel();
    prankFlagIconAnimation?.cancel();
    prankFlagAnimation = prankFlagIconAnimation = null;
    prankFlag?.remove();
    prankFlag = null;
    prankPointer = null;
  }
  function placePrankItem(entry, x, y) {
    entry.x = x;
    entry.y = y;
    entry.node.style.left = `${x}px`;
    entry.node.style.top = `${y}px`;
  }
  function animatePrankPosition(entry, x, y, returning = false) {
    const r = entry.node.getBoundingClientRect();
    entry.animation?.cancel();
    placePrankItem(entry, x, y);
    const animation = animate(
      entry.node,
      [
        { left: `${r.left}px`, top: `${r.top}px` },
        { left: `${x}px`, top: `${y}px` },
      ],
      {
        duration: returning ? 360 : 280,
        easing: prankMoveEasing,
        fill: "both",
      },
    );
    animation.id = returning
      ? "holiday-prank-button-return"
      : "holiday-prank-button-escape";
    entry.animation = animation;
    void animation.finished.then(
      () => {
        if (entry.animation === animation) {
          entry.animation = null;
          animation.cancel();
        }
      },
      () => {},
    );
    return animation;
  }
  function dodgePrankItem(entry, pointer) {
    const bar = visible(targets.chrome)?.getBoundingClientRect();
    if (!bar) return;
    const left = bar.left + 24,
      right = Math.max(left, innerWidth - entry.width - 24);
    const top = Math.min(bar.bottom + 126, innerHeight - entry.height - 24);
    const bottom = Math.max(top, innerHeight - entry.height - 112);
    let best = null;
    for (let index = 0; index < 12; index++) {
      const x =
        left +
        ((right - left) * ((index * 5 + entry.seed + entry.hops) % 7)) / 6;
      const y =
        top +
        ((bottom - top) * ((index * 3 + entry.seed + entry.hops) % 5)) / 4;
      const distance = Math.hypot(
        x + entry.width / 2 - pointer.x,
        y + entry.height / 2 - pointer.y,
      );
      const crowded = [...prankItems.values()].some(
        (other) =>
          other !== entry &&
          x < other.x + other.width + 12 &&
          x + entry.width + 12 > other.x &&
          y < other.y + other.height + 12 &&
          y + entry.height + 12 > other.y,
      );
      const score = distance - (crowded ? 1000 : 0);
      if (!best || score > best.score) best = { x, y, score };
    }
    entry.hops++;
    entry.node.dataset.hops = String(entry.hops);
    recordPrankMoves(1);
    animatePrankPosition(entry, best.x, best.y);
  }
  function syncPrank() {
    if (!config.theme.prank || config.bare) {
      clearPrank();
      return;
    }
    const controls = visible(".topbar .window-controls");
    if (!controls) return;
    if (prankMoveCount > 10 && !prankSurrendered && !prankFlag?.isConnected) {
      prankFlag = document.createElement("button");
      prankFlag.className = "holiday-prank-flag";
      prankFlag.type = "button";
      prankFlag.innerHTML = config.art.whiteFlag;
      prankFlag.setAttribute("aria-label", "举白旗，恢复正常按钮");
      prankFlag.dataset.tooltip = "举白旗，结束恶作剧";
      listen(prankFlag, "click", () => {
        if (prankSurrendered) return;
        prankSurrendered = true;
        for (const [target, entry] of prankItems) {
          entry.node.dataset.returning = "true";
          entry.node.querySelector("button").tabIndex = -1;
          const r = target.getBoundingClientRect();
          const animation = animatePrankPosition(entry, r.left, r.top, true);
          void animation.finished.then(
            () => {
              if (prankItems.get(target) === entry)
                removePrankItem(target, entry);
            },
            () => {},
          );
        }
        clearPrankSidebar(true);
        animatePrankFlag(false);
        options.onSurrender?.();
      });
      controls.insertBefore(
        prankFlag,
        controls.querySelector('button[aria-label="最小化窗口"]'),
      );
      animatePrankFlag(true);
    }
    if (!prankActive()) return;
    const buttons = [...document.querySelectorAll(prankSelectors)].filter(
      (target) =>
        (target.classList.contains("launch-primary")
          ? target.getAttribute("aria-label") === "开始游戏"
          : target.textContent.trim() === "切换版本") &&
        !target.disabled &&
        !target.closest(".holiday-overlay,[hidden],[inert]") &&
        target.getClientRects().length,
    );
    const retained = new Set(buttons);
    for (const [target, entry] of prankItems)
      if (!retained.has(target)) removePrankItem(target, entry);
    for (const target of buttons) {
      const r = target.getBoundingClientRect();
      let entry = prankItems.get(target);
      if (!entry) {
        const node = document.createElement("span");
        node.className = "holiday-node holiday-prank-proxy";
        node.dataset.control = target.classList.contains("launch-primary")
          ? "launch"
          : target.classList.contains("launch-switch")
            ? "version"
            : "tool";
        const computed = getComputedStyle(target);
        for (const property of computed)
          if (property.startsWith("--"))
            node.style.setProperty(
              property,
              computed.getPropertyValue(property),
            );
        const clone = target.cloneNode(true);
        for (const child of [
          clone,
          ...clone.querySelectorAll("[id],[data-april-original]"),
        ]) {
          child.removeAttribute("id");
          child.removeAttribute("data-april-original");
        }
        clone.type = "button";
        for (const property of [
          "color",
          "font-family",
          "font-size",
          "font-weight",
          "line-height",
        ])
          clone.style.setProperty(
            property,
            computed.getPropertyValue(property),
          );
        const context = document.createElement("div");
        context.className = target.closest(".launch-actions")
          ? "launch-dock"
          : "notice-actions";
        if (context.className === "launch-dock") {
          const actions = document.createElement("div");
          actions.className = "launch-actions";
          actions.append(clone);
          context.append(actions);
        } else context.append(clone);
        node.append(context);
        entry = {
          node,
          seed: prankSerial++,
          hops: 0,
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
        };
        node.dataset.hops = "0";
        layer.append(node);
        prankItems.set(target, entry);
        target.dataset.aprilOriginal = "true";
      }
      entry.width = r.width;
      entry.height = r.height;
      entry.node.style.width = `${r.width}px`;
      entry.node.style.height = `${r.height}px`;
      if (!entry.hops) placePrankItem(entry, r.left, r.top);
      else {
        const x = Math.min(entry.x, innerWidth - r.width - 12),
          y = Math.min(entry.y, innerHeight - r.height - 12);
        if (x !== entry.x || y !== entry.y) animatePrankPosition(entry, x, y);
      }
      if (
        prankPointer &&
        prankPointer.x >= entry.x - 28 &&
        prankPointer.x <= entry.x + entry.width + 28 &&
        prankPointer.y >= entry.y - 28 &&
        prankPointer.y <= entry.y + entry.height + 28
      )
        dodgePrankItem(entry, prankPointer);
    }
  }
  listen(
    document,
    "pointermove",
    (event) => {
      if (prankActive()) prankPointer = { x: event.clientX, y: event.clientY };
    },
    { passive: true },
  );
  listen(
    document,
    "wheel",
    (event) => {
      if (
        !prankActive() ||
        !(event.target instanceof Element) ||
        event.target.closest(".sidebar-favorites")
      )
        return;
      const list = document.querySelector(".sidebar-favorites");
      if (!list || list.scrollHeight <= list.clientHeight) return;
      const r = list.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? list.clientHeight
            : 1;
      list.scrollTop += event.deltaY * unit;
      event.preventDefault();
    },
    { passive: false },
  );
  for (const type of [
    "pointerdown",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
  ])
    listen(
      document,
      type,
      (event) => {
        if (
          !prankActive() ||
          (type === "keydown" && !["Enter", " "].includes(event.key))
        )
          return;
        if (!(event.target instanceof Element)) return;
        const proxy = event.target.closest?.(".holiday-prank-proxy"),
          original = event.target.closest?.("[data-april-original=true]"),
          sidebar = event.target.closest?.(
            "[data-april-sidebar=true],[data-april-favorite-original=true]",
          );
        if (!proxy && !original && !sidebar) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (sidebar) {
          const entry =
            prankSidebarItems.get(sidebar) ||
            [...prankSidebarItems.values()].find(
              (item) => item.node === sidebar,
            );
          if (entry) {
            prankHoverSlot = entry.slot;
            swapPrankSidebarItem(entry);
          }
          return;
        }
        const entry = proxy
          ? [...prankItems.values()].find((item) => item.node === proxy)
          : prankItems.get(original);
        if (entry)
          dodgePrankItem(entry, {
            x: entry.x + entry.width / 2,
            y: entry.y + entry.height / 2,
          });
      },
      true,
    );
  const homeGreetings = {
    spring: "新春快乐",
    dragon: "端午安康",
    moon: "中秋快乐",
    spooky: "万圣奇妙夜",
    winter: "圣诞快乐",
  };
  const greetingPrefix = new RegExp(
    `^(?:你好|${Object.values(homeGreetings).join("|")})(?=，)`,
  );
  function syncHomeGreeting() {
    const greeting = config.bare
      ? "你好"
      : homeGreetings[config.season] || "你好";
    for (const heading of document.querySelectorAll(
      '.page[data-page="home"] .page-title-copy>h1',
    )) {
      const text = heading.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE) continue;
      const next = text.data.replace(greetingPrefix, greeting);
      if (next !== text.data) text.data = next;
    }
  }
  function removeSpringProfile(profile, node) {
    node.remove();
    springProfiles.delete(profile);
  }
  function syncSpringProfiles() {
    const profiles =
      config.theme.profileTrim && config.layers.edges && !config.bare
        ? [...document.querySelectorAll(".sidebar .profile-button")]
        : [];
    const retained = new Set(profiles);
    for (const [profile, node] of springProfiles)
      if (!retained.has(profile)) removeSpringProfile(profile, node);
    for (const profile of profiles) {
      if (springProfiles.get(profile)?.isConnected) continue;
      const node = document.createElement("span");
      node.className = "holiday-spring-profile";
      node.setAttribute("aria-hidden", "true");
      node.innerHTML = config.art.profileTrim;
      // Attach to the card so its decorations follow sidebar resizing and movement.
      profile.append(node);
      springProfiles.set(profile, node);
    }
  }
  function removeAvatarHat(avatar, node) {
    node.remove();
    avatarHats.delete(avatar);
  }
  function syncAvatarHats() {
    const avatars =
      config.theme.avatarHat && config.layers.edges && !config.bare
        ? [...document.querySelectorAll(".sidebar .profile-button .avatar")]
        : [];
    const retained = new Set(avatars);
    for (const [avatar, node] of avatarHats)
      if (!retained.has(avatar)) removeAvatarHat(avatar, node);
    for (const avatar of avatars) {
      if (avatarHats.get(avatar)?.isConnected) continue;
      const node = document.createElement("span");
      node.className = "holiday-avatar-hat";
      node.setAttribute("aria-hidden", "true");
      node.innerHTML = config.art.avatarHat;
      // Inherit the avatar's native position, hover rotation and scale.
      avatar.append(node);
      avatarHats.set(avatar, node);
    }
  }
  function removePumpkinAvatar(avatar, node) {
    node.remove();
    delete avatar.dataset.holidayPumpkinAvatar;
    pumpkinAvatars.delete(avatar);
  }
  function syncPumpkinAvatars() {
    const avatars =
      config.theme.avatarHover && config.layers.edges && !config.bare
        ? [...document.querySelectorAll(".sidebar .profile-button .avatar")]
        : [];
    const retained = new Set(avatars);
    for (const [avatar, node] of pumpkinAvatars)
      if (!retained.has(avatar)) removePumpkinAvatar(avatar, node);
    for (const avatar of avatars) {
      let node = pumpkinAvatars.get(avatar);
      if (!node?.isConnected) {
        node = document.createElement("span");
        node.className = "holiday-pumpkin-avatar";
        node.setAttribute("aria-hidden", "true");
        node.innerHTML = config.art.avatarHover;
        avatar.append(node);
        pumpkinAvatars.set(avatar, node);
      }
      // Use the native avatar frame and its existing hover tilt and scale.
      avatar.dataset.holidayPumpkinAvatar = "true";
    }
  }
  const selectionIcons =
    '.pixel-select-option[aria-selected="true"] .pixel-option-check>svg,.launch-version-option[aria-selected="true"]>.launch-option-check,.version-list .selected .version-selection>svg,.install-component-option[aria-checked="true"]>svg.lucide-check';
  function removeSelectionMarker(icon, entry) {
    entry.node.remove();
    delete icon.dataset.holidaySelectionReplaced;
    selectionItems.delete(icon);
  }
  function syncSelectionMarkers() {
    const enabled = !config.bare && !!config.art.selectionMarker;
    const icons = enabled ? [...document.querySelectorAll(selectionIcons)] : [];
    const retained = new Set(icons);
    for (const [icon, entry] of selectionItems)
      if (!retained.has(icon)) removeSelectionMarker(icon, entry);
    for (const icon of icons) {
      let entry = selectionItems.get(icon);
      if (!entry || !entry.node.isConnected) {
        const holder = document.createElement("div");
        holder.innerHTML = config.art.selectionMarker;
        const node = holder.firstElementChild;
        node.classList.add("holiday-selection-art");
        node.setAttribute("width", "100%");
        node.setAttribute("height", "100%");
        node.setAttribute("data-marker", config.selectionMarker);
        icon.append(node);
        entry = { node };
        selectionItems.set(icon, entry);
      }
      // The native SVG retains its size, clipping, opacity and selection semantics.
      icon.dataset.holidaySelectionReplaced = "true";
    }
  }
  const visible = (selector, followCardMotion = false) =>
    [...document.querySelectorAll(selector)].find((element) => {
      const inert = element.closest("[inert]"),
        style = getComputedStyle(element);
      // An inactive launch control can still be painted during the card's exit.
      return (
        !element.closest(".holiday-overlay,[hidden]") &&
        (!inert || (followCardMotion && inert.matches(".launch-dock"))) &&
        element.getClientRects().length &&
        style.visibility !== "hidden" &&
        (!followCardMotion || Number(style.opacity) > 0)
      );
    });
  const targets = {
    brand: ".sidebar .brand",
    wordmark: ".sidebar .brand-wordmark",
    profile: ".sidebar .profile-button",
    chrome: ".topbar",
    "card-ribbon": ".launch-dock-card",
    "card-zongzi": ".launch-dock-card",
    "card-mooncake": ".launch-dock-card",
    launch: ".launch-primary",
    tab: '[role="tab"][aria-selected="true"]',
    tabs: '[role="tablist"]',
    menu: '[role="menu"],.favorite-context-menu',
  };
  function add(slot, art, target, place) {
    if (!art) return;
    const node = document.createElement("span");
    node.className = `holiday-node ${slot}`;
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = art;
    layer.append(node);
    items.push({
      node,
      target,
      place,
      followCardMotion:
        target === ".launch-dock-card" ||
        ["moon-companions", "witch-hat", "witch-cape"].includes(slot),
      last: "",
    });
  }
  const rect = (x, y, width, height, rotate = 0) => ({
    x,
    y,
    width,
    height,
    rotate,
  });
  function removeTabPin(tab, entry) {
    entry.animation?.cancel();
    entry.node.remove();
    if (tabPins.get(tab) === entry) tabPins.delete(tab);
  }
  function animateTabPin(tab, entry, show) {
    if (entry.wanted === show) return;
    const art = entry.node.firstElementChild,
      current = getComputedStyle(art);
    const from = { transform: current.transform, opacity: current.opacity };
    entry.animation?.cancel();
    entry.wanted = show;
    entry.node.dataset.phase = show ? "entering" : "leaving";
    art.style.transform = show
      ? "rotate(0deg) scale(1)"
      : "rotate(160deg) scale(0.12)";
    art.style.opacity = show ? "1" : "0";
    const frames = show
      ? [
          from,
          { transform: "rotate(-16deg) scale(1.12)", opacity: 1, offset: 0.75 },
          { transform: "rotate(0deg) scale(1)", opacity: 1 },
        ]
      : [from, { transform: "rotate(160deg) scale(0.12)", opacity: 0 }];
    // Match the full spin/scale/fade motion already chosen for holiday Tabs.
    const animation = animate(art, frames, {
      duration: show ? 420 : 320,
      easing: show ? "cubic-bezier(0.22,1,0.36,1)" : "cubic-bezier(0.4,0,1,1)",
      fill: "both",
    });
    entry.animation = animation;
    void animation.finished.then(
      () => {
        if (entry.animation !== animation) return;
        entry.animation = null;
        animation.cancel();
        entry.node.dataset.phase = show ? "active" : "inactive";
        if (!show) removeTabPin(tab, entry);
      },
      () => {},
    );
  }
  function syncTabPins() {
    const position = config.theme.tabPinPosition;
    const animated = ["top-left", "bottom-left"].includes(position);
    const enabled =
      ["top-left", "bottom-right", "bottom-left"].includes(position) &&
      config.layers.tabs &&
      !config.bare;
    const tabVisible = (tab) =>
      tab.isConnected &&
      !tab.closest("[hidden],[inert]") &&
      tab.getClientRects().length &&
      getComputedStyle(tab).visibility !== "hidden";
    const tabs = enabled
      ? [
          ...document.querySelectorAll(
            '.tab-items>[role="tab"][aria-selected="true"]',
          ),
        ].filter(tabVisible)
      : [];
    const retained = new Set(tabs);
    for (const tab of tabs) {
      if (!tabPins.has(tab)) {
        const node = document.createElement("span");
        node.className = `holiday-node tab-pin tab-pin-${position}`;
        node.setAttribute("aria-hidden", "true");
        node.dataset.tabId = tab.id;
        node.innerHTML = config.art.tabPin;
        if (animated)
          node.firstElementChild.style.transform =
            "rotate(-160deg) scale(0.16)";
        layer.append(node);
        tabPins.set(tab, { node, last: "", wanted: null, animation: null });
      }
    }
    for (const [tab, entry] of tabPins) {
      if (
        !tabVisible(tab) ||
        !entry.node.isConnected ||
        (position === "bottom-right" && !retained.has(tab))
      ) {
        removeTabPin(tab, entry);
        continue;
      }
      const r = tab.getBoundingClientRect(),
        height = Math.min(20, r.height / 2),
        width = height * 1.6;
      // Lower ornaments straddle the tab edge; left pins stay mostly inside horizontally.
      const placement =
          position === "bottom-right"
            ? rect(r.right - width / 2, r.bottom - height / 2, width, height)
            : position === "bottom-left"
              ? rect(
                  r.left - width / 8,
                  r.bottom - height / 2,
                  width,
                  height,
                  12,
                )
              : rect(r.left - width / 8, r.top - height / 2, width, height),
        key = JSON.stringify(placement);
      if (key !== entry.last) {
        entry.last = key;
        Object.assign(entry.node.style, {
          left: `${placement.x}px`,
          top: `${placement.y}px`,
          width: `${width}px`,
          height: `${height}px`,
          transform: `rotate(${placement.rotate}deg)`,
        });
      }
      if (animated) animateTabPin(tab, entry, retained.has(tab));
    }
  }
  function tabIconSlots() {
    return [
      ...document.querySelectorAll('.tab-items>[role="tab"]>.tab-content'),
    ].flatMap((content) => {
      const icon = content.firstElementChild;
      return icon?.matches("svg,img") &&
        !content.closest("[hidden],[inert]") &&
        content.getClientRects().length &&
        getComputedStyle(content).visibility !== "hidden"
        ? [{ content, icon }]
        : [];
    });
  }
  function removeFu(content, entry) {
    entry.animation?.cancel();
    if (!content.isConnected) cancelIconMotion(content);
    entry.node.remove();
    delete content.dataset.holidayFuReplaced;
    fuItems.delete(content);
  }
  function cancelIconMotion(content) {
    const icon = content.firstElementChild,
      motion = icon && iconMotions.get(icon);
    if (motion) {
      motion.animation.cancel();
      iconMotions.delete(icon);
    }
    delete content.dataset.holidayIconEntering;
  }
  function revealIcon(content) {
    const icon = content.firstElementChild;
    if (!icon?.matches("svg,img")) return;
    const previous = iconMotions.get(icon),
      current = getComputedStyle(icon);
    const target = previous?.target || {
      transform: current.transform,
      opacity: current.opacity,
    };
    const from = previous
      ? { transform: current.transform, opacity: current.opacity }
      : { transform: "rotate(-180deg) scale(0.16)", opacity: 0 };
    cancelIconMotion(content);
    content.dataset.holidayIconEntering = "true";
    const animation = animate(
      icon,
      [
        from,
        {
          transform: "rotate(16deg) scale(1.12)",
          opacity: target.opacity,
          offset: 0.75,
        },
        target,
      ],
      { duration: 420, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "both" },
    );
    const motion = { animation, target };
    iconMotions.set(icon, motion);
    void animation.finished.then(
      () => {
        if (iconMotions.get(icon) !== motion) return;
        animation.cancel();
        iconMotions.delete(icon);
        delete content.dataset.holidayIconEntering;
      },
      () => {},
    );
  }
  function animateFu(content, entry, show) {
    if (entry.wanted === show) return;
    const image = entry.node.firstElementChild;
    const current = getComputedStyle(image);
    const from = entry.node.hidden
      ? { transform: "rotate(-180deg) scale(0.16)", opacity: 0 }
      : { transform: current.transform, opacity: current.opacity };
    entry.animation?.cancel();
    if (show) cancelIconMotion(content);
    entry.wanted = show;
    entry.node.hidden = false;
    entry.node.dataset.phase = show ? "entering" : "leaving";
    content.dataset.holidayFuReplaced = "true";
    image.style.transform = show
      ? "rotate(0deg) scale(1)"
      : "rotate(180deg) scale(0.12)";
    image.style.opacity = show ? "1" : "0";
    // These full spin/scale/fade effects follow the user's explicit motion choice.
    const frames = show
      ? [
          from,
          { transform: "rotate(-20deg) scale(1.12)", opacity: 1, offset: 0.75 },
          { transform: "rotate(0deg) scale(1)", opacity: 1 },
        ]
      : [from, { transform: "rotate(180deg) scale(0.12)", opacity: 0 }];
    const animation = animate(image, frames, {
      duration: show ? 420 : 320,
      easing: show ? "cubic-bezier(0.22,1,0.36,1)" : "cubic-bezier(0.4,0,1,1)",
      fill: "both",
    });
    entry.animation = animation;
    void animation.finished.then(
      () => {
        if (entry.animation !== animation) return;
        entry.animation = null;
        animation.cancel();
        entry.node.dataset.phase = show ? "active" : "inactive";
        if (!show) {
          entry.node.hidden = true;
          // Start from transparent before revealing the original icon in this frame.
          revealIcon(content);
          delete content.dataset.holidayFuReplaced;
          if (entry.removeAfter) removeFu(content, entry);
        }
      },
      () => {},
    );
  }
  function syncFu(slots) {
    const enabled = config.theme.tabFu && config.layers.tabs && !config.bare;
    const retained = new Set(enabled ? slots.map((slot) => slot.content) : []);
    for (const [content, entry] of fuItems) {
      entry.removeAfter = !retained.has(content);
      if (!entry.node.isConnected) removeFu(content, entry);
      else if (entry.removeAfter) {
        animateFu(content, entry, false);
        if (entry.node.hidden) removeFu(content, entry);
      }
    }
    if (!enabled) return;
    for (const { content, icon } of slots) {
      let entry = fuItems.get(content);
      if (!entry) {
        const node = document.createElement("span");
        node.className = "holiday-tab-fu";
        node.setAttribute("aria-hidden", "true");
        node.hidden = true;
        node.innerHTML = config.art.tabFu;
        content.append(node);
        entry = { node, wanted: false, removeAfter: false, animation: null };
        fuItems.set(content, entry);
        if (content.parentElement.getAttribute("aria-selected") !== "true")
          revealIcon(content);
      }
      const style = getComputedStyle(icon),
        iconWidth = parseFloat(style.width),
        iconHeight = parseFloat(style.height);
      const width = Math.max(24, iconWidth),
        height = Math.max(24, iconHeight),
        left = (iconWidth - width) / 2;
      if (entry.node.style.width !== `${width}px`)
        entry.node.style.width = `${width}px`;
      if (entry.node.style.height !== `${height}px`)
        entry.node.style.height = `${height}px`;
      if (entry.node.style.left !== `${left}px`)
        entry.node.style.left = `${left}px`;
      animateFu(
        content,
        entry,
        content.parentElement.getAttribute("aria-selected") === "true",
      );
    }
  }
  function rebuild(next) {
    if (next.season !== "fools" || config?.season !== "fools") {
      prankSurrendered = false;
      prankMoveCount = 0;
    }
    clearPrank();
    if (next.season === "fools")
      document.documentElement.dataset.aprilMoves = String(prankMoveCount);
    else delete document.documentElement.dataset.aprilMoves;
    drag = null;
    for (const [icon, entry] of selectionItems)
      removeSelectionMarker(icon, entry);
    for (const [tab, entry] of tabPins) removeTabPin(tab, entry);
    for (const [avatar, node] of pumpkinAvatars)
      removePumpkinAvatar(avatar, node);
    for (const [avatar, node] of avatarHats) removeAvatarHat(avatar, node);
    for (const [profile, node] of springProfiles)
      removeSpringProfile(profile, node);
    for (const [mark, node] of titleMoons) removeTitleMoon(mark, node);
    config = next;
    items = [];
    hanger = cord = null;
    layer.replaceChildren();
    layer.hidden = next.bare;
    layer.dataset.motion = String(next.motion);

    document.documentElement.dataset.holidayBanner = "false";
    document.documentElement.dataset.holidayTabFu = String(
      !next.bare && next.layers.tabs && !!next.theme.tabFu,
    );
    defs.innerHTML = next.defs;
    const t = next.theme,
      art = next.art;
    if (t.lanternRow && next.layers.hanger)
      add("lantern-row", art.lanternRow, targets.chrome, (r) =>
        rect(r.left + 10, r.bottom - 1, Math.max(0, r.width - 20), 34),
      );
    if (t.christmasRow && next.layers.hanger)
      add("christmas-row", art.christmasRow, targets.chrome, (r) =>
        rect(r.left + 10, r.bottom - 1, Math.max(0, r.width - 20), 32),
      );
    if (next.layers.edges)
      for (const extra of next.extras) {
        const { slot, html } = extra;
        const target = targets[slot.startsWith("brand") ? "brand" : slot];
        const place =
          slot === "card-ribbon"
            ? (r, target) => {
                const scale = r.width / target.offsetWidth;
                return rect(
                  r.left - 7 * scale,
                  r.top - 16 * scale,
                  56 * scale,
                  78 * scale,
                );
              }
            : slot === "card-zongzi"
              ? (r, target) => {
                  const scale = r.width / target.offsetWidth;
                  return rect(
                    r.left - 14 * scale,
                    r.top - 12 * scale,
                    32 * scale,
                    48 * scale,
                  );
                }
              : slot === "card-mooncake"
                ? (r, target) => {
                    const scale = r.width / target.offsetWidth;
                    return rect(
                      r.left - 16 * scale,
                      r.top - 14 * scale,
                      32 * scale,
                      32 * scale,
                    );
                  }
                : slot === "brand-ribbon-top"
                  ? (r) => rect(r.right - 42, r.top - 7, 40, 31, 12)
                  : slot === "brand-ribbon-edge"
                    ? (r) =>
                        rect(r.left + 3, r.top - 3, r.width - 6, r.height + 4)
                    : slot === "wordmark"
                      ? (r) => rect(r.right - 18, r.top - 12, 46, 38)
                      : slot === "chrome"
                        ? (r) => rect(r.right - 220, r.bottom - 10, 110, 40)
                        : slot === "profile" && next.season === "moon"
                          ? (r) => rect(r.right - 42, r.top - 16, 43, 38)
                          : (r) => rect(r.right - 42, r.top - 22, 43, 38);
        add(slot, html, target, place);
      }
    if (next.layers.buttons && t.buttons) {
      if (t.banner)
        add("holiday-couplet", art.couplet, targets.launch, (r) =>
          rect(r.left, r.top, r.width, r.height),
        );
      else if (t.top === "dragonBoat")
        add("boat", art.buttonTop, targets.launch, (r, target) => {
          const scale = r.width / target.offsetWidth,
            height = (innerWidth <= 900 ? 48 : 64) * scale;
          // The control's top edge begins 6px inside each stepped corner.
          return rect(
            r.left + 6 * scale,
            r.top - height,
            r.width - 12 * scale,
            height,
          );
        });
      else if (t.top === "moonCompanions")
        add("moon-companions", art.buttonTop, targets.launch, (r, target) => {
          const scale = r.width / target.offsetWidth,
            height = 56 * scale;
          return rect(
            r.left + 6 * scale,
            r.top - height + 2 * scale,
            r.width - 12 * scale,
            height,
          );
        });
      else if (t.top === "witch")
        add("witch-hat", art.buttonTop, targets.launch, (r, target) => {
          const scale = r.width / target.offsetWidth;
          return rect(
            r.left - 11 * scale,
            r.top - 38 * scale,
            56 * scale,
            42 * scale,
          );
        });
      else
        add("button-top", art.buttonTop, targets.launch, (r) =>
          rect(r.left - 15, r.top - 30, 57, 44, -10),
        );
      if (t.buttonEdge !== false && !t.banner) {
        if (next.season === "spooky")
          add("witch-cape", art.buttonEdge, targets.launch, (r, target) => {
            const scale = r.width / target.offsetWidth;
            return rect(
              r.left - 7 * scale,
              r.top - 5 * scale,
              r.width + 14 * scale,
              r.height + 17 * scale,
            );
          });
        else
          add("button-edge", art.buttonEdge, targets.launch, (r) =>
            rect(r.left - 7, r.top - 5, r.width + 14, r.height + 17),
          );
      }
    }
    if (next.layers.tabs) {
      if (t.tab)
        add("tab-lights", art.tab, targets.tabs, (r) =>
          rect(r.left + 18, r.top - 3, Math.min(238, r.width - 20), 23),
        );
      if (
        t.tabPin &&
        !["top-left", "bottom-right", "bottom-left"].includes(t.tabPinPosition)
      )
        add("tab-pin", art.tabPin, targets.tab, (r) =>
          rect(r.right - 12, r.bottom - 3, 30, 25),
        );
    }
    if (next.layers.menus) {
      if (t.menuTop) {
        if (t.menu === "witch")
          add("menu-top", art.menu, targets.menu, (r, target) => {
            const scale = r.width / target.offsetWidth;
            return rect(
              r.right - 42 * scale,
              r.top - 33 * scale,
              48 * scale,
              36 * scale,
            );
          });
        else
          add("menu-top", art.menu, targets.menu, (r) =>
            rect(r.right - 37, r.top - 22, 50, 39),
          );
      }
      if (t.menuEdge)
        add("menu-edge", art.menuEdge, targets.menu, (r) =>
          rect(r.left - 15, r.bottom - 27, 35, 40),
        );
    }
    if (t.hanger && next.layers.hanger && !next.bare) {
      const holder = document.createElement("div");
      holder.innerHTML =
        '<svg class="holiday-cord" aria-hidden="true"><path/><circle r="4"/></svg>';
      cord = holder.firstElementChild;
      hanger = document.createElement("button");
      hanger.className = "holiday-hanger";
      hanger.dataset.anchor = t.hanger;
      hanger.innerHTML = art.hanger;
      hanger.setAttribute(
        "aria-label",
        `${t.name}挂件：拖动或方向键移动，Home 复位`,
      );
      hanger.disabled = !next.drag;
      hanger.style.pointerEvents = next.drag ? "auto" : "none";
      hanger.tabIndex = next.drag ? 0 : -1;
      layer.append(cord, hanger);
      listen(hanger, "pointerdown", (event) => {
        if (!config.drag || event.button !== 0) return;
        event.preventDefault();
        const r = hanger.getBoundingClientRect();
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: r.left,
          top: r.top,
        };
        hanger.setPointerCapture(event.pointerId);
        hanger.classList.add("dragging");
      });
      listen(hanger, "pointermove", (event) => {
        if (drag?.id === event.pointerId)
          move(
            drag.left + event.clientX - drag.x,
            drag.top + event.clientY - drag.y,
          );
      });
      const end = () => {
        drag = null;
        hanger.classList.remove("dragging");
      };
      listen(hanger, "pointerup", end);
      listen(hanger, "pointercancel", end);
      listen(hanger, "keydown", (event) => {
        if (event.key === "Home") {
          delete positions[config.season];
          return;
        }
        const step = event.shiftKey ? 20 : 5,
          delta = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          }[event.key];
        if (delta) {
          event.preventDefault();
          const r = hanger.getBoundingClientRect();
          move(r.left + delta[0], r.top + delta[1]);
        }
      });
    }
  }
  function move(x, y) {
    const width = hanger.offsetWidth,
      height = hanger.offsetHeight,
      minTop = config.theme.hanger === "brand" ? 0 : 40;
    positions[config.season] = {
      x:
        Math.max(5, Math.min(innerWidth - width - 5, x)) / (innerWidth - width),
      y:
        Math.max(minTop, Math.min(innerHeight - height - 5, y)) /
        (innerHeight - height),
    };
  }
  let capabilities = "";
  function paint() {
    frame = 0;
    if (disposed || document.hidden) return;
    if (config) {
      syncPrank();
      syncPrankSidebar();
      if (options.manageGreeting) syncHomeGreeting();
      const iconSlots = tabIconSlots();
      syncFu(iconSlots);
      syncTabPins();
      syncSelectionMarkers();
      syncPumpkinAvatars();
      syncAvatarHats();
      syncSpringProfiles();
      syncTitleMoons();
      const banner =
        !config.bare &&
        config.layers.buttons &&
        config.theme.banner &&
        visible(targets.launch)?.getAttribute("aria-label") === "开始游戏";
      document.documentElement.dataset.holidayBanner = String(!!banner);
      for (const item of items) {
        const target =
          item.target && visible(item.target, item.followCardMotion);
        item.node.hidden =
          !target ||
          (item.node.classList.contains("holiday-couplet") && !banner);
        if (item.node.hidden) continue;
        if (item.node.classList.contains("holiday-couplet")) {
          for (const [state, pseudo] of [
            ["hover", ":hover"],
            ["focus", ":focus-visible"],
            ["active", ":active"],
          ]) {
            const value = String(target.matches(pseudo));
            if (item.node.dataset[state] !== value)
              item.node.dataset[state] = value;
          }
        }
        const r = item.place(target.getBoundingClientRect(), target);
        if (item.node.classList.contains("boat"))
          item.node.style.setProperty(
            "--boat-scale",
            target.getBoundingClientRect().width / target.offsetWidth,
          );
        if (item.followCardMotion)
          item.node.style.opacity = getComputedStyle(
            target.closest(".launch-dock-card") || target,
          ).opacity;
        const key = JSON.stringify(r);
        if (key !== item.last) {
          item.last = key;
          Object.assign(item.node.style, {
            left: `${r.x}px`,
            top: `${r.y}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            transform: `rotate(${r.rotate}deg)`,
          });
        }
      }
      if (hanger) {
        const onBrand = config.theme.hanger === "brand",
          brand = onBrand && visible(targets.brand),
          r = brand && brand.getBoundingClientRect();
        hanger.hidden = cord.hidden = onBrand && !brand;
        const width = hanger.offsetWidth || 34,
          height = hanger.offsetHeight || 51,
          p = positions[config.season];
        const anchorX = r ? r.right - 17 : innerWidth - 45,
          anchorY = r ? r.top + 2 : 13;
        const x = p
          ? p.x * (innerWidth - width)
          : r
            ? anchorX - width / 2
            : 0.88 * (innerWidth - width);
        const y = p
          ? Math.max(onBrand ? 0 : 40, p.y * (innerHeight - height))
          : r
            ? anchorY + 2
            : Math.max(40, 0.17 * (innerHeight - height));
        hanger.style.transform = `translate(${x}px,${y}px)`;
        cord.querySelector("circle").setAttribute("cx", anchorX);
        cord.querySelector("circle").setAttribute("cy", anchorY);
        cord.querySelector("circle").setAttribute("r", onBrand ? 2 : 4);
        cord
          .querySelector("path")
          .setAttribute(
            "d",
            `M${anchorX} ${anchorY} Q${anchorX} ${(anchorY + y) / 2} ${x + width / 2} ${y + 3}`,
          );
      }
      const next = JSON.stringify({
        tabs: !!visible(targets.tabs),
        tabIcons: iconSlots.length > 0,
        menu: !!visible(targets.menu),
      });
      if (next !== capabilities) {
        capabilities = next;
        options.onCapabilities?.(JSON.parse(next));
      }
    }
    frame = requestAnimationFrame(paint);
  }

  rebuild(initialConfig);
  document.documentElement.dataset.holidaySeason = initialConfig.season;
  frame = requestAnimationFrame(paint);
  listen(document, "visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (!frame && !disposed) frame = requestAnimationFrame(paint);
  });
  return {
    update(next) {
      if (disposed) return;
      rebuild(next);
      document.documentElement.dataset.holidaySeason = next.season;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      clearPrank();
      for (const [content, entry] of fuItems) {
        cancelIconMotion(content);
        removeFu(content, entry);
      }
      for (const [icon, entry] of selectionItems)
        removeSelectionMarker(icon, entry);
      for (const [tab, entry] of tabPins) removeTabPin(tab, entry);
      for (const [avatar, node] of pumpkinAvatars)
        removePumpkinAvatar(avatar, node);
      for (const [avatar, node] of avatarHats) removeAvatarHat(avatar, node);
      for (const [profile, node] of springProfiles)
        removeSpringProfile(profile, node);
      for (const [mark, node] of titleMoons) removeTitleMoon(mark, node);
      for (const content of document.querySelectorAll(
        "[data-holiday-icon-entering]",
      ))
        cancelIconMotion(content);
      for (const animation of animations) animation.cancel();
      animations.clear();
      style.remove();
      defs.remove();
      layer.remove();
      for (const name of [
        "holidayBanner",
        "holidayTabFu",
        "holidaySeason",
        "aprilMoves",
      ])
        delete document.documentElement.dataset[name];
    },
  };
}
