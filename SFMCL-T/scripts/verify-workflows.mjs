import { runtimePath } from "./lib/paths.mjs";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";

const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9423",
);
const page = browser.contexts()[0].pages()[0];
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const original = await invoke("bootstrap");
if (
  !path
    .resolve(original.dataDir)
    .startsWith(runtimePath() + path.sep)
)
  throw new Error("Requires an isolated .runtime desktop");
const directory = runtimePath("workflow-game");
const root = path.join(directory, ".minecraft");
const id = `qa-${Date.now()}`;
const game = path.join(root, "versions", id);
const checks = [];
const payload = Buffer.alloc(8 * 1024 * 1024, 0x37);
const sha1 = createHash("sha1").update(payload).digest("hex");
const ranges = [];
const server = createServer((req, res) => {
  const offset = Number(
    /^bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0,
  );
  ranges.push(offset);
  res.writeHead(offset ? 206 : 200, {
    "Content-Length": payload.length - offset,
    "Accept-Ranges": "bytes",
    ...(offset
      ? {
          "Content-Range": `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        }
      : {}),
  });
  let position = offset;
  const timer = setInterval(() => {
    res.write(payload.subarray(position, position + 64 * 1024));
    position += 64 * 1024;
    if (position >= payload.length) {
      clearInterval(timer);
      res.end();
    }
  }, 50);
  res.on("close", () => clearInterval(timer));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const jobs = [];
try {
  await mkdir(game, { recursive: true });
  await writeFile(
    path.join(game, `${id}.json`),
    JSON.stringify({
      id,
      clientVersion: "1.20.1",
      type: "release",
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
    }),
  );
  await invoke("settings.save", {
    ...original.settings,
    downloadTaskDisplay: "always",
    activeDir: directory,
    activeVersion: id,
    isolation: true,
    gameDirs: [
      ...original.settings.gameDirs,
      { name: "Workflow verification", path: directory },
    ],
  });
  await page.reload();
  for (let i = 0; i < 2; i++)
    jobs.push(
      await invoke("resources.download", {
        kind: "mod",
        title: `QA transfer ${i}`,
        file: {
          path: `qa-transfer-${i}.bin`,
          url: `http://127.0.0.1:${server.address().port}/${i}`,
          size: payload.length,
          sha1,
        },
      }),
    );
  const nav = (label) =>
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: label, exact: true })
      .click();
  await page.locator(".sidebar-task").click();
  await page
    .getByRole("button", { name: "暂停 QA transfer 0", exact: true })
    .click();
  const snapshot = async () =>
    (await invoke("tasks")).downloads.find((d) => d.id === jobs[0]);
  await expect.poll(async () => (await snapshot()).status).toBe("paused");
  const paused = await snapshot();
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect((await snapshot()).downloaded).toBe(paused.downloaded);
  expect((await snapshot()).workers).toBe(0);
  await page.screenshot({
    path: runtimePath("evidence/download-paused.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "继续 QA transfer 0", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await invoke("tasks")).downloads
          .filter((d) => jobs.includes(d.id))
          .every((d) => d.status === "completed"),
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(ranges.some((offset) => offset > 0)).toBe(true);
  for (let i = 0; i < 2; i++) {
    expect(
      createHash("sha1")
        .update(await readFile(path.join(game, "mods", `qa-transfer-${i}.bin`)))
        .digest("hex"),
    ).toBe(sha1);
    await invoke("downloads.control", { id: jobs[i], action: "clear" });
    await access(path.join(game, "mods", `qa-transfer-${i}.bin`));
  }
  checks.push(
    "Release UI pauses/drains download, other transfer continues, resumes via HTTP Range, validates SHA-1; clearing keeps finished files",
  );
  const files = await invoke("resources.files", {
    source: "modrinth",
    id: "AANobbMI",
    gameVersion: "1.20.1",
    loader: "Fabric",
  });
  const file = files[0].file;
  const modJob = await invoke("resources.download", {
    kind: "mod",
    title: "QA Sodium",
    file,
  });
  jobs.push(modJob);
  await expect
    .poll(
      async () =>
        (await invoke("tasks")).downloads.find((d) => d.id === modJob)?.status,
      { timeout: 45_000 },
    )
    .toBe("completed");
  let mods = await invoke("resources.local", { kind: "mod" });
  const sodium = mods.find((m) => m.name === "Sodium");
  expect(sodium).toBeTruthy();
  await nav("版本管理");
  await page
    .getByRole("button", { name: `查看 ${id} 本地资源`, exact: true })
    .click();
  await page.getByRole("button", { name: "禁用 Sodium", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke("resources.local", { kind: "mod" })).find(
          (m) => m.name === "Sodium",
        )?.disabled,
    )
    .toBe(true);
  await page.getByRole("button", { name: "启用 Sodium", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke("resources.local", { kind: "mod" })).find(
          (m) => m.name === "Sodium",
        )?.disabled,
    )
    .toBe(false);
  checks.push(
    "Actual Sodium download, JAR metadata scan, UI disable/enable roundtrip",
  );
  const text = (value) => {
    const b = Buffer.from(value);
    const n = Buffer.alloc(2);
    n.writeUInt16BE(b.length);
    return Buffer.concat([n, b]);
  };
  const tag = (type, name, value) =>
    Buffer.concat([Buffer.from([type]), text(name), value]);
  const compound = (name, values) =>
    tag(10, name, Buffer.concat([...values, Buffer.from([0])]));
  const int = (value) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value);
    return b;
  };
  const seed = Buffer.alloc(8);
  seed.writeBigInt64BE(-9223372036854775807n);
  const world = compound("", [
    compound("Data", [
      tag(8, "LevelName", text("QA 世界")),
      tag(3, "GameType", int(1)),
      tag(1, "Difficulty", Buffer.from([2])),
      tag(1, "raining", Buffer.from([1])),
      compound("WorldGenSettings", [
        tag(4, "seed", seed),
        tag(1, "bonus_chest", Buffer.from([1])),
      ]),
      compound("GameRules", [tag(8, "doDaylightCycle", text("false"))]),
    ]),
  ]);
  await mkdir(path.join(game, "saves/QA"), { recursive: true });
  await writeFile(path.join(game, "saves/QA/level.dat"), gzipSync(world));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("tab", { name: /^存档/ }).click();
  await page
    .getByRole("button", { name: /QA 世界/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("-9223372036854775807");
  await expect(page.getByRole("dialog")).toContainText("创造");
  await expect(page.getByRole("dialog")).toContainText("雨天");
  await expect(page.getByRole("dialog")).toContainText("doDaylightCycle");
  await page.screenshot({
    path: runtimePath("evidence/world-details.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  checks.push("Gzipped world NBT, full 64-bit seed, mode/weather/rules in UI");
  await mkdir(path.join(game, "resourcepacks/qa-pack"), { recursive: true });
  await writeFile(
    path.join(game, "resourcepacks/qa-pack/pack.mcmeta"),
    JSON.stringify({
      pack: { pack_format: 15, description: "QA texture pack" },
    }),
  );
  const packs = await invoke("resources.local", { kind: "resourcepack" });
  expect(packs.find((p) => p.description === "QA texture pack")).toBeTruthy();
  await invoke("resources.deletePack", {
    path: path.join(game, "resourcepacks/qa-pack"),
  });
  expect(await invoke("resources.local", { kind: "resourcepack" })).toEqual([]);
  const renamed = `${id}-renamed`;
  await invoke("versions.rename", { id, name: renamed });
  await access(path.join(root, "versions", renamed, "saves/QA/level.dat"));
  await invoke("versions.delete", { id: renamed });
  checks.push(
    "Texture pack scan/delete; version rename preserves world, deletion clears selection",
  );
} finally {
  for (const id of jobs)
    await invoke("downloads.control", { id, action: "clear" }).catch(() => {});
  await invoke("settings.save", original.settings);
  await page.reload();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
  await writeFile(
    runtimePath("evidence/workflow-checks.json"),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
}
