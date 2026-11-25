import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  parseMinecraftText,
  type MinecraftTextRun,
} from "./minecraftFormatting";
import "./minecraft-text.css";

const glyphs = Array.from(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*+=?<>|/\\[]{}.,:;_-方块星光森林天空世界山水火木石矿云雨雪风金银铜钻红绿蓝黄紫黑白◆◇■□▲△",
);

function ObfuscatedText({ text }: { text: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const characters = useMemo(() => Array.from(text), [text]);
  const [scrambled, setScrambled] = useState<string[]>([]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const context = document.createElement("canvas").getContext("2d");
    const style = getComputedStyle(element);
    if (context)
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const widths = glyphs.map(
      (glyph) => context?.measureText(glyph).width ?? 0,
    );
    const pools = characters.map((character) => {
      if (/\s/u.test(character)) return [character];
      const width = context?.measureText(character).width ?? 0;
      const matches = glyphs.filter(
        (_, index) => Math.abs(widths[index] - width) < 0.1,
      );
      return matches.length ? matches : [character];
    });
    const shuffle = () =>
      setScrambled(
        pools.map((pool) => pool[Math.floor(Math.random() * pool.length)]),
      );
    shuffle();
    const timer = window.setInterval(() => {
      if (!document.hidden && element.getClientRects().length) shuffle();
    }, 80);
    return () => window.clearInterval(timer);
  }, [characters]);
  return (
    <span ref={root} className="minecraft-obfuscated">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {characters.map((character, index) => (
          <span key={index} className="minecraft-obfuscated-character">
            <span className="minecraft-obfuscated-source">{character}</span>
            <span className="minecraft-obfuscated-glyph">
              {scrambled[index] ?? character}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

function Run({ run }: { run: MinecraftTextRun }) {
  const decoration = [
    run.underline && "underline",
    run.strikethrough && "line-through",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className="minecraft-text-run"
      style={{
        color: run.color,
        fontWeight: run.bold ? "bold" : undefined,
        fontStyle: run.italic ? "italic" : undefined,
        textDecorationLine: decoration || undefined,
      }}
    >
      {run.obfuscated ? <ObfuscatedText text={run.text} /> : run.text}
    </span>
  );
}

export function MinecraftText({ text }: { text: string }) {
  const runs = useMemo(() => parseMinecraftText(text), [text]);
  if (!text.includes("§")) return text;
  return (
    <span className="minecraft-text">
      {runs.map((run, index) => (
        <Run key={`${index}:${run.text}`} run={run} />
      ))}
    </span>
  );
}
