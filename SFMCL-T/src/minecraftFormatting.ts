const colors: Record<string, string> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff",
};

export interface MinecraftTextStyle {
  color?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}
export interface MinecraftTextRun extends MinecraftTextStyle {
  text: string;
}
const plain: MinecraftTextStyle = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  obfuscated: false,
};
const flags: Record<string, keyof Omit<MinecraftTextStyle, "color">> = {
  k: "obfuscated",
  l: "bold",
  m: "strikethrough",
  n: "underline",
  o: "italic",
};

/** Java Edition's legacy section-sign codes, including color/style resets. */
export function parseMinecraftText(text: string): MinecraftTextRun[] {
  const runs: MinecraftTextRun[] = [];
  let style = { ...plain };
  let pending = "";
  const flush = () => {
    if (!pending) return;
    const previous = runs.at(-1);
    if (
      previous &&
      previous.color === style.color &&
      previous.bold === style.bold &&
      previous.italic === style.italic &&
      previous.underline === style.underline &&
      previous.strikethrough === style.strikethrough &&
      previous.obfuscated === style.obfuscated
    )
      previous.text += pending;
    else runs.push({ ...style, text: pending });
    pending = "";
  };
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "§") {
      pending += text[index];
      continue;
    }
    flush();
    if (++index === text.length) break;
    const code = text[index].toLowerCase();
    if (colors[code]) style = { ...plain, color: colors[code] };
    else if (code === "r") style = { ...plain };
    else if (flags[code]) style = { ...style, [flags[code]]: true };
    // Minecraft consumes unknown code pairs without changing the current style.
  }
  flush();
  return runs;
}

export function minecraftPlainText(text: string): string {
  return parseMinecraftText(text)
    .map((run) => run.text)
    .join("");
}
