import type { MiningState } from "./downloadMiningState";

type BlockKind = "stone" | "ore";
type Block = {
  kind: BlockKind;
  element: HTMLDivElement;
  cracks: HTMLImageElement[];
  chips: HTMLDivElement[];
};
const assets = "/assets/minecraft/downloads/";
const crackStages = [2, 5, 8];
const timing = {
  strike: 288,
  hits: 3,
  breaking: 96,
  advancing: 220,
  gap: 38,
  dropping: 416,
  collecting: 480,
};
const idleDuration = 8500 / 1.5;

function idlePose(time: number) {
  const smooth = (value: number) => value * value * (3 - 2 * value);
  let y = 15;
  let angle = -16;
  if (time < 2) {
    y -= Math.sin(time * Math.PI) * 1.3;
    angle += Math.sin(time * Math.PI) * 6;
  } else if (time < 2.6) {
    const progress = smooth((time - 2) / 0.6);
    y += 3 * progress;
    angle -= 20 * progress;
  } else if (time < 4.2) {
    const progress = (time - 2.6) / 1.6;
    y = 18 - 13 * Math.sin(progress * Math.PI);
    angle = -36 + 380 * smooth(progress);
  } else if (time < 5.2) {
    const progress = time - 4.2;
    const bounce = Math.sin(progress * Math.PI * 3) * (1 - progress);
    y = 18 - 3 * smooth(progress) + 2.8 * bounce;
    // Keep the completed revolution so interpolation never unwinds the throw.
    angle = 344 + 16 * bounce;
  } else {
    const progress = (time - 5.2) / 3.3;
    y -= Math.sin(progress * Math.PI * 2) * 0.7;
    angle = 344 + Math.sin(progress * Math.PI * 2) * 1.5;
  }
  return { y, angle };
}

const idlePoses = Array.from({ length: 171 }, (_, index) => ({
  offset: index / 170,
  ...idlePose(index / 20),
}));
const idlePickFrames = idlePoses.map(({ offset, y, angle }) => {
  // Undo the fixed -16° swing around the handle before rotating at the sprite's
  // center. The outer mining anchor stays in place, including during handoff.
  const radians = (16 * Math.PI) / 180;
  const dx = 19 - 38 * 0.2;
  const dy = 19 - 38 * 0.9 + y - 10;
  const x = Math.cos(radians) * dx - Math.sin(radians) * dy - dx;
  const translateY =
    Math.sin(radians) * dx + Math.cos(radians) * dy - (19 - 38 * 0.9);
  return {
    offset,
    transform: `translate(${x}px, ${translateY}px) rotate(${angle + 16}deg)`,
  };
});
const idleShadowFrames = idlePoses.map(({ offset, y }) => ({
  offset,
  opacity: 0.11,
  transform: `scaleX(${(12 - (15 - y) * 0.1) / 12})`,
}));

/** Owns only the queue and transforms; task polling never recreates the scene. */
export function createDownloadMiningMotion(scene: HTMLDivElement) {
  const queue = scene.querySelector<HTMLDivElement>(".download-mine-queue")!;
  const pick = scene.querySelector<HTMLDivElement>(".download-mine-pick")!;
  const pickSprite = pick.querySelector<HTMLImageElement>("img")!;
  const diamonds = [
    ...scene.querySelectorAll<HTMLImageElement>(".download-mine-diamond"),
  ];
  const shadow = scene.querySelector<HTMLElement>(".download-mine-shadow")!;
  const sparks = [
    ...scene.querySelectorAll<HTMLElement>(".download-mine-spark"),
  ];
  let idleAnimations: Animation[] = [];
  let handoffAnimations: Animation[] = [];
  let warming = false;
  let hasPlayback = false;
  let pendingReset = false;
  let miningPickTransform = "rotate(-16deg)";
  let blocks: Block[] = [];
  let state: MiningState = "idle";
  let phase:
    | "mining"
    | "breaking"
    | "advancing"
    | "dropping"
    | "collecting"
    | "restocking"
    | "idle" = "mining";
  let elapsed = 0;
  let renderedHits = 0;
  let started = false;
  let finishing = false;
  let oreQueued = false;
  let visible = true;
  let disposed = false;
  let frame = 0;
  let last: number | null = null;

  const restQueue = document.createElement("div");
  restQueue.className = "download-mine-rest-queue";
  for (let index = 0; index < 2; index++) {
    const stone = document.createElement("img");
    stone.src = `${assets}stone.png`;
    stone.alt = "";
    stone.draggable = false;
    stone.style.transform = `translateX(${index * timing.gap}px)`;
    restQueue.append(stone);
  }
  queue.after(restQueue);

  function setMiningPick(angle: number) {
    miningPickTransform = `rotate(${angle}deg)`;
    pick.style.transform = miningPickTransform;
  }

  function makeBlock(kind: BlockKind, index: number): Block {
    const element = document.createElement("div");
    element.className = "download-mine-block";
    element.dataset.kind = kind;
    element.style.transform = `translateX(${index * timing.gap}px)`;
    const sprite = document.createElement("img");
    sprite.src = `${assets}${kind === "ore" ? "diamond-ore" : "stone"}.png`;
    sprite.alt = "";
    sprite.draggable = false;
    element.append(sprite);
    // Load all three textures before their hit so the fast final stage never
    // depends on swapping an image URL at contact time.
    const cracks = crackStages.map((stage) => {
      const crack = document.createElement("img");
      crack.src = `${assets}destroy_oit_stage_${stage}-cube.png`;
      crack.alt = "";
      crack.draggable = false;
      crack.className = "download-mine-cracks";
      crack.dataset.stage = String(stage);
      element.append(crack);
      return crack;
    });
    const chips = Array.from({ length: 4 }, () => {
      const chip = document.createElement("div");
      chip.className = "download-mine-chip";
      chip.append(sprite.cloneNode());
      chip.append(cracks[cracks.length - 1].cloneNode());
      element.append(chip);
      return chip;
    });
    return { kind, element, cracks, chips };
  }

  function setPhase(next: typeof phase) {
    phase = next;
    elapsed = 0;
    if (next === "mining") renderedHits = 0;
    scene.dataset.phase = next;
  }

  function reset() {
    blocks = [makeBlock("stone", 0), makeBlock("stone", 1)];
    queue.replaceChildren(...blocks.map((b) => b.element));
    started = finishing = oreQueued = false;
    setPhase("mining");
    pendingReset = false;
    delete scene.dataset.reward;
    miningPickTransform = "rotate(-16deg)";
    hideDiamonds();
  }

  function requestReset() {
    pendingReset = true;
    started = finishing = oreQueued = false;
    delete scene.dataset.reward;
    hideDiamonds();
    // Replace the hidden mining queue after its fade, keeping the outgoing
    // block and pick pose intact while entering the resting scene.
    if (warming && !handoffAnimations.length) reset();
  }

  function hideDiamonds() {
    diamonds.forEach((d) => {
      d.style.opacity = "0";
    });
  }

  function appendBlock(kind: BlockKind) {
    const block = makeBlock(kind, 2);
    queue.append(block.element);
    blocks.push(block);
  }

  function finishCollection() {
    // Keep the same stone that was waiting behind the ore, now in the front slot.
    blocks.forEach((b, i) => {
      b.element.style.transform = `translateX(${i * timing.gap}px)`;
      b.element.style.opacity = "1";
    });
    started = finishing = oreQueued = false;
    setPhase("idle");
    scene.dataset.visual = "idle";
    scene.dataset.reward = "collected";
    syncPickWarmup();
  }

  function advance() {
    if (phase === "mining") {
      blocks[0].element.dataset.breaking = "true";
      setPhase("breaking");
    } else if (phase === "breaking") {
      const mined = blocks.shift()!;
      mined.element.remove();
      if (mined.kind === "ore") {
        setMiningPick(-16);
        scene.dataset.reward = "mined";
        setPhase("dropping");
        return;
      }
      const kind = finishing && !oreQueued ? "ore" : "stone";
      appendBlock(kind);
      if (kind === "ore") oreQueued = true;
      setPhase("advancing");
    } else if (phase === "dropping") setPhase("collecting");
    else if (phase === "collecting") {
      hideDiamonds();
      appendBlock("stone");
      setPhase("restocking");
    } else if (phase === "restocking") finishCollection();
    else setPhase("mining");
  }

  function draw() {
    if (!blocks.length) return;
    blocks.forEach((b, i) => (b.element.style.zIndex = String(3 - i)));
    if (phase === "mining") {
      const t = (elapsed % timing.strike) / timing.strike;
      const poses = [
        [0, -16],
        [0.28, -52],
        [0.5, 22],
        [0.62, 14],
        [1, -16],
      ];
      const end = poses.findIndex(([at]) => at >= t);
      const a = poses[Math.max(0, end - 1)],
        b = poses[end];
      const mix = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
      setMiningPick(a[1] + ((b[1] - a[1]) * (1 - Math.cos(mix * Math.PI))) / 2);
      const hits = Math.min(
        timing.hits,
        Math.floor(elapsed / timing.strike + 0.5),
      );
      blocks[0].cracks.forEach((crack, index) => {
        crack.style.opacity = hits === index + 1 ? "1" : "0";
      });
      blocks.forEach((b, i) => {
        b.element.style.transform = `translateX(${i * timing.gap}px)`;
        b.element.style.opacity = "1";
      });
    } else if (phase === "breaking") {
      const t = elapsed / timing.breaking;
      setMiningPick(22 - 38 * t);
      const offsets = [
        [-15, -10],
        [16, -12],
        [-12, 13],
        [15, 11],
      ];
      blocks[0].chips.forEach((chip, i) => {
        chip.style.transform = `translate(${offsets[i][0] * t}px,${offsets[i][1] * t + 8 * t * t}px) rotate(${(i % 2 ? 1 : -1) * t * 16}deg)`;
        chip.style.opacity = String(1 - t);
      });
    } else if (phase === "advancing" || phase === "restocking") {
      setMiningPick(-16);
      const t = elapsed / timing.advancing,
        eased = t * t * (3 - 2 * t);
      blocks.forEach((b, i) => {
        b.element.style.transform = `translateX(${(i + 1 - eased) * timing.gap}px)`;
        b.element.style.opacity = String(i === 1 ? Math.min(1, t * 4) : 1);
      });
    } else if (phase === "dropping") {
      const t = elapsed / timing.dropping;
      const y =
        t < 0.7
          ? -14 * (1 - t / 0.7) - 12 * Math.sin((Math.PI * t) / 0.7)
          : -3 * Math.sin((Math.PI * (t - 0.7)) / 0.3);
      diamonds.forEach((d) => {
        d.style.opacity = "1";
        d.style.transform = `translateY(${y}px) scale(${0.65 + 0.35 * Math.min(1, t * 4)})`;
      });
    } else if (phase === "collecting") {
      const t = elapsed / timing.collecting;
      diamonds.forEach((d, i) => {
        d.style.opacity = "1";
        d.style.transform = `translate(${-160 * t}px,${-18 * Math.sin(Math.PI * t)}px) rotate(${-200 * t * (i ? 1 : 0.7)}deg)`;
      });
    }
  }

  const canAnimate = () =>
    !disposed &&
    visible &&
    !document.hidden &&
    !handoffAnimations.length &&
    phase !== "idle" &&
    (state === "running" || finishing);

  function tick(now: number) {
    frame = 0;
    if (!canAnimate()) {
      last = null;
      return;
    }
    elapsed += last === null ? 0 : Math.min(now - last, 80);
    last = now;
    if (phase === "mining") {
      const hits = Math.min(
        timing.hits,
        Math.floor(elapsed / timing.strike + 0.5),
      );
      if (hits > renderedHits) {
        // Present each contact for a frame even when a slow frame crosses
        // its narrow peak, keeping all three hits and textures visible.
        elapsed = timing.strike * (hits - 0.5);
        renderedHits = hits;
      }
    }
    const duration =
      phase === "mining"
        ? timing.strike * (timing.hits - 0.45)
        : phase === "breaking"
          ? timing.breaking
          : phase === "dropping"
            ? timing.dropping
            : phase === "collecting"
              ? timing.collecting
              : timing.advancing;
    if (elapsed >= duration) advance();
    draw();
    if (canAnimate()) frame = requestAnimationFrame(tick);
  }

  function capturePose() {
    return {
      anchor: getComputedStyle(pick).transform,
      sprite: getComputedStyle(pickSprite).transform,
      shadow: getComputedStyle(shadow).opacity,
      sparks: sparks.map((spark) => ({
        opacity: getComputedStyle(spark).opacity,
        transform: getComputedStyle(spark).transform,
      })),
    };
  }

  function handoff(from: ReturnType<typeof capturePose>, waiting: boolean) {
    const options: KeyframeAnimationOptions = {
      duration: 260,
      easing: "cubic-bezier(0.22, 0.8, 0.3, 1)",
    };
    handoffAnimations = [
      pick.animate(
        [{ transform: from.anchor }, { transform: pick.style.transform }],
        { ...options, id: "download-mine-handoff-anchor" },
      ),
      pickSprite.animate(
        [
          { transform: from.sprite },
          { transform: waiting ? idlePickFrames[0].transform : "none" },
        ],
        { ...options, id: "download-mine-handoff-pick" },
      ),
      shadow.animate(
        [{ opacity: from.shadow }, { opacity: waiting ? 0.11 : 0 }],
        { ...options, id: "download-mine-handoff-shadow" },
      ),
      ...sparks.map((spark, index) =>
        spark.animate(
          [from.sparks[index], { ...from.sparks[index], opacity: 0 }],
          { ...options, id: `download-mine-handoff-spark-${index}` },
        ),
      ),
    ];
    scene.dataset.handoff = waiting ? "warmup" : "mining";
    const anchor = handoffAnimations[0];
    anchor.onfinish = () => {
      if (disposed || handoffAnimations[0] !== anchor) return;
      const finished = handoffAnimations;
      handoffAnimations = [];
      delete scene.dataset.handoff;
      finished.forEach((animation) => animation.cancel());
      if (pendingReset && warming) reset();
      syncPlayback();
    };
  }

  function syncPickWarmup() {
    const waiting = state !== "running" && !finishing;
    scene.dataset.visual = waiting ? "idle" : "running";
    if (waiting !== warming || !hasPlayback) {
      // Capture both nested transforms before cancelling either animation.
      // Their origins stay fixed, so reversals retain the exact rendered pose.
      const from = capturePose();
      handoffAnimations.forEach((animation) => animation.cancel());
      handoffAnimations = [];
      idleAnimations.forEach((animation) => animation.cancel());
      idleAnimations = [];
      warming = waiting;
      pick.style.transform = waiting ? "rotate(-16deg)" : miningPickTransform;
      if (waiting) {
        const options: KeyframeAnimationOptions = {
          duration: idleDuration,
          iterations: Infinity,
          easing: "linear",
        };
        idleAnimations = [
          pickSprite.animate(idlePickFrames, {
            ...options,
            id: "download-mine-idle-warmup",
          }),
          shadow.animate(idleShadowFrames, {
            ...options,
            id: "download-mine-idle-shadow",
          }),
          ...sparks.map((spark, index) => {
            const angle = (index * Math.PI) / 2 + 0.6;
            const from = `translate(${Math.cos(angle) * 10}px, ${Math.sin(angle) * 10}px) scale(1)`;
            const to = `translate(${Math.cos(angle) * 18}px, ${Math.sin(angle) * 18}px) scale(0.01)`;
            return spark.animate(
              [
                { offset: 0, opacity: 0, transform: from },
                { offset: 4.2 / 8.5, opacity: 0, transform: from },
                { offset: 4.25 / 8.5, opacity: 0.6, transform: from },
                { offset: 5.2 / 8.5, opacity: 0, transform: to },
                { offset: 1, opacity: 0, transform: to },
              ],
              { ...options, id: `download-mine-idle-spark-${index}` },
            );
          }),
        ];
        idleAnimations.forEach((animation) => {
          animation.pause();
          animation.currentTime = 0;
        });
      }
      if (hasPlayback) handoff(from, waiting);
      hasPlayback = true;
    }
    const playing = visible && !document.hidden;
    const pause = (animation: Animation) => {
      const time = animation.currentTime;
      animation.pause();
      // Resolve the pending pause at this pose, including mid-handoff.
      if (time !== null) animation.currentTime = time;
    };
    for (const animation of idleAnimations) {
      const playIdle = playing && waiting && !handoffAnimations.length;
      if (playIdle && animation.playState === "paused") animation.play();
      if (!playIdle && animation.playState !== "paused") pause(animation);
    }
    for (const animation of handoffAnimations) {
      if (animation.playState === "finished") continue;
      if (playing && animation.playState === "paused") animation.play();
      if (!playing && animation.playState !== "paused") pause(animation);
    }
  }

  function syncPlayback() {
    scene.dataset.paused = String(!visible || document.hidden);
    syncPickWarmup();
    if (canAnimate()) {
      if (!frame) frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
      last = null;
    }
  }

  reset();
  document.addEventListener("visibilitychange", syncPlayback);
  return {
    setState(next: MiningState) {
      if (state === next) return;
      state = next;
      if (next === "idle" || next === "cancelled") requestReset();
      else if (next === "running") {
        if (finishing || pendingReset) reset();
        if (phase === "idle") setPhase("mining");
        delete scene.dataset.reward;
        started = true;
        scene.dataset.visual = "running";
      } else if (next === "done") {
        if (started) finishing = true;
        else {
          reset();
          setPhase("idle");
        }
      } else if (finishing || phase === "idle") requestReset();
      syncPlayback();
    },
    setVisible(value: boolean) {
      visible = value;
      syncPlayback();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      idleAnimations.forEach((animation) => animation.cancel());
      handoffAnimations.forEach((animation) => animation.cancel());
      restQueue.remove();
      document.removeEventListener("visibilitychange", syncPlayback);
      queue.replaceChildren();
    },
  };
}
