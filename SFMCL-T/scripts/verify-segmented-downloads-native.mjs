import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { runtimePath } from "./lib/paths.mjs";

const evidence = runtimePath("segmented-downloads");
const destination = path.join(evidence, "native-files", Date.now().toString());
await mkdir(destination, { recursive: true });
const cache = (
  await readFile(path.join(evidence, "native-cache-path.txt"), "utf8")
).trim();
const size = 4 * 1048576;
const payload = Buffer.alloc(size);
for (let i = 0; i < size; i++) payload[i] = i % 251;
const sha1 = createHash("sha1").update(payload).digest("hex");
let active = 0,
  peak = 0,
  requests = [];
const server = createServer(async (req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  const ignored = req.url.startsWith("/ignore/");
  let start = !ignored && range ? Number(range[1]) : 0;
  const end = !ignored && range?.[2] ? Number(range[2]) : size - 1;
  requests.push({
    url: req.url,
    range: req.headers.range ?? null,
    ifRange: req.headers["if-range"] ?? null,
  });
  res.writeHead(!ignored && range ? 206 : 200, {
    "Content-Length": end - start + 1,
    ETag: '"native-v1"',
    ...(!ignored && range
      ? { "Content-Range": `bytes ${start}-${end}/${size}` }
      : {}),
  });
  active++;
  peak = Math.max(peak, active);
  res.once("close", () => active--);
  try {
    while (start <= end && !res.destroyed) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (res.destroyed) break;
      const next = Math.min(start + 32768, end + 1);
      if (!res.write(payload.subarray(start, next)))
        await new Promise((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            res.off("close", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
        });
      start = next;
    }
    res.end();
  } catch {
    res.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9435",
);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const errors = [],
  checks = [],
  ids = [];
page.on("pageerror", (e) => errors.push(e.message));
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
const original = await invoke("bootstrap");
if (!path.resolve(original.dataDir).startsWith(evidence + path.sep))
  throw new Error("Use an isolated native data directory");
const task = async (id) =>
  (await invoke("tasks")).downloads.find((v) => v.id === id);
const begin = async (mode, title, name) => {
  const id = await invoke("resources.download", {
    kind: "mod",
    title,
    directory: destination,
    file: { url: `${url}/${mode}/${name}`, path: name, size, sha1 },
  });
  ids.push(id);
  return id;
};
const sameHash = async (name) =>
  expect(
    createHash("sha1")
      .update(await readFile(path.join(destination, name)))
      .digest("hex"),
  ).toBe(sha1);
try {
  expect(original.settings.downloadConnectionLimit).toBe(16);
  await invoke("settings.save", {
    ...original.settings,
    downloadConcurrency: 8,
    downloadConnectionLimit: 2,
    downloadCacheDir: cache,
    minecraftDownloadSource: "official",
  });
  await page.reload();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(page.getByLabel("同时下载数", { exact: true })).toHaveValue("8");
  const limit = page.getByLabel("同时连接数", { exact: true });
  await expect(limit).toHaveValue("2");
  await limit.fill("0");
  await limit.blur();
  await expect
    .poll(
      async () => (await invoke("bootstrap")).settings.downloadConnectionLimit,
    )
    .toBe(1);
  await limit.fill("33");
  await limit.blur();
  await expect
    .poll(
      async () => (await invoke("bootstrap")).settings.downloadConnectionLimit,
    )
    .toBe(32);
  await limit.fill("2");
  await limit.blur();
  await expect
    .poll(
      async () => (await invoke("bootstrap")).settings.downloadConnectionLimit,
    )
    .toBe(2);
  await page.screenshot({
    path: path.join(evidence, "native-settings.png"),
    fullPage: true,
  });
  checks.push(
    "Native default, independent file/connection controls, auto-save and 1..32 bounds",
  );
  const id = await begin("valid", "原生分片验证", "native-valid.bin");
  await page.locator(".sidebar-task").click();
  await expect
    .poll(async () => (await task(id)).downloaded)
    .toBeGreaterThan(131072);
  await page
    .getByRole("button", { name: "暂停 原生分片验证", exact: true })
    .click();
  await expect.poll(async () => (await task(id)).status).toBe("paused");
  expect((await task(id)).workers).toBe(0);
  const owned = path.join(cache, "tmcl-downloads", id);
  const digest = createHash("sha1").update("native-valid.bin").digest("hex");
  const meta = path.join(owned, `${digest}.part.segments.json`);
  const recorded = await readFile(meta);
  const metadata = JSON.parse(recorded);
  expect(metadata.segments).toHaveLength(4);
  for (const [i, segment] of metadata.segments.entries()) {
    const length = await stat(
      path.join(owned, `${digest}.part.segment-${i}`),
    ).then(
      (s) => s.size,
      () => 0,
    );
    expect(length).toBe(segment.downloaded);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await readFile(meta)).toEqual(recorded);
  checks.push(
    "Pause drains all writers and persists fixed four ranges and durable offsets",
  );
  await invoke("settings.save", {
    ...(await invoke("bootstrap")).settings,
    downloadConnectionLimit: 4,
  });
  await page
    .getByRole("button", { name: "继续 原生分片验证", exact: true })
    .click();
  await expect.poll(async () => (await task(id)).status).toBe("completed");
  expect(peak).toBe(4);
  expect((await task(id)).downloaded).toBe(size);
  await sameHash("native-valid.bin");
  await expect(page.locator(`[data-download-id="${id}"]`)).toContainText(
    "个文件正在下载",
  );
  await page.screenshot({
    path: path.join(evidence, "native-completed.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "清理 原生分片验证", exact: true })
    .click();
  await expect.poll(async () => await task(id)).toBeUndefined();
  expect(
    await stat(owned).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  await sameHash("native-valid.bin");
  checks.push(
    "Runtime increase to four connections, resume, SHA-1, C: cache to D: atomic commit and UI cleanup",
  );
  requests = [];
  peak = 0;
  const ignored = await begin("ignore", "原生普通回退", "native-plain.bin");
  await expect.poll(async () => (await task(ignored)).status).toBe("completed");
  expect(requests).toHaveLength(1);
  expect(peak).toBe(1);
  await sameHash("native-plain.bin");
  await invoke("downloads.control", { id: ignored, action: "clear" });
  checks.push(
    "Ignored Range probe reuses one full response and commits the correct file",
  );
  const cancelled = await begin("valid", "原生取消验证", "native-cancel.bin");
  await expect
    .poll(async () => (await task(cancelled)).downloaded)
    .toBeGreaterThan(65536);
  await invoke("downloads.control", { id: cancelled, action: "cancel" });
  expect((await task(cancelled)).workers).toBe(0);
  await invoke("downloads.control", { id: cancelled, action: "clear" });
  expect(
    await stat(path.join(destination, "native-cancel.bin")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(
    await stat(path.join(cache, "tmcl-downloads", cancelled)).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  checks.push(
    "Native cancellation drains workers and removes only task-owned segment files",
  );
  expect(errors).toEqual([]);
  await writeFile(
    path.join(evidence, "native-checks.json"),
    JSON.stringify({ checks, errors, pausedMetadata: metadata }, null, 2),
  );
  console.log(
    `PASS ${checks.length} native segmented download checks; page errors: ${errors.length}`,
  );
} finally {
  for (const id of ids) {
    try {
      if (await task(id)) {
        await invoke("downloads.control", { id, action: "cancel" });
        await invoke("downloads.control", { id, action: "clear" });
      }
    } catch {}
  }
  await invoke("settings.save", original.settings);
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
