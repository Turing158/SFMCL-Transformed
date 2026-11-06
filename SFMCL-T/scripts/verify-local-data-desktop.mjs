import { chromium, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { projectPath, runtimePath } from "./lib/paths.mjs";

if (process.platform !== "win32")
  throw new Error("The desktop profile-transfer check requires Windows");
const run = promisify(execFile);
const root = runtimePath(`local-data-desktop-${Date.now()}`);
if (!path.resolve(root).startsWith(runtimePath() + path.sep))
  throw new Error("Test output must stay inside .runtime");
const source = path.join(root, "original");
const target = path.join(root, "migrated");
const backup = path.join(root, "profile.zip");
const binary = path.join(root, "bin", "sfmcl-t.exe");
await mkdir(path.dirname(binary), { recursive: true });
await mkdir(source);
await copyFile(
  process.env.SFMCL_T_TEST_BINARY ||
    projectPath("target/x86_64-pc-windows-msvc/debug/sfmcl-t.exe"),
  binary,
);
await writeFile(
  path.join(source, "settings.json"),
  JSON.stringify({
    gameDirs: [],
    activeDir: "",
    activeVersion: "",
    activePlayer: "",
    homeCleanMode: true,
    theme: "light",
    backgroundType: "none",
  }),
);
await writeFile(path.join(source, "marker.bin"), Buffer.from([0, 1, 2, 255]));
await writeFile(
  path.join(source, "paths.json"),
  JSON.stringify({
    inside: path.join(source, "marker.bin"),
    outside: path.join(root, "external.bin"),
  }),
);
const port = Number(process.env.SFMCL_T_TEST_CDP_PORT || 9437);
const env = {
  ...process.env,
  SFMCL_T_DATA_DIR: source,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
};
const child = spawn(binary, [], { env, windowsHide: true, stdio: "ignore" });
const checks = [];
let browser, page;
const connect = async () => {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1500,
      });
      page = browser
        .contexts()[0]
        .pages()
        .find((page) => !page.url().startsWith("devtools:"));
      if (!page) throw new Error("WebView is starting");
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, {
        timeout: 3000,
      });
      await expect(
        page.getByRole("navigation", { name: "主导航" }),
      ).toBeVisible({ timeout: 10000 });
      return;
    } catch (error) {
      last = error;
      await browser?.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last;
};
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const transfer = async (kind, file) => {
  const operation = await invoke("local-data.prepare", { kind, path: file });
  const closed = page.waitForEvent("close", { timeout: 15000 });
  expect(await invoke("local-data.execute", { id: operation.id })).toEqual({
    restarting: true,
  });
  await closed;
  await browser.close().catch(() => {});
  await connect();
  const data = await invoke("bootstrap");
  expect(
    data.localDataResult?.success,
    JSON.stringify(data.localDataResult),
  ).toBe(true);
  expect(data.localDataResult.kind).toBe(kind);
  await expect(page.locator(".local-data-settings")).toBeVisible();
  return data;
};
try {
  await connect();
  const initial = await invoke("bootstrap");
  expect(path.resolve(initial.dataDir)).toBe(source);
  await invoke("players.add", { name: "Data_QA" });
  const players = await invoke("players.list");
  expect(players.some((player) => player.name === "Data_QA")).toBe(true);
  const occupied = path.join(root, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep.txt"), "keep");
  await expect(
    invoke("local-data.prepare", { kind: "migrate", path: occupied }),
  ).rejects.toThrow("空文件夹");
  expect(await readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("keep");
  checks.push(
    "Native preflight rejects an occupied destination without modifying either directory",
  );

  await transfer("backup", backup);
  expect((await readFile(backup)).subarray(0, 2).toString()).toBe("PK");
  expect(
    (await invoke("players.list")).some((player) => player.name === "Data_QA"),
  ).toBe(true);
  checks.push(
    "Backup closes the real WebView, writes a verified ZIP and reopens the same profile",
  );

  const moved = await transfer("migrate", target);
  expect(path.resolve(moved.dataDir)).toBe(target);
  await expect(readFile(path.join(source, "marker.bin"))).rejects.toThrow();
  expect(await readFile(path.join(target, "marker.bin"))).toEqual(
    Buffer.from([0, 1, 2, 255]),
  );
  const paths = JSON.parse(
    await readFile(path.join(target, "paths.json"), "utf8"),
  );
  expect(path.resolve(paths.inside)).toBe(path.join(target, "marker.bin"));
  expect(paths.outside).toBe(path.join(root, "external.bin"));
  checks.push(
    "Migration moves the real profile, updates internal paths and persists the new location across restart",
  );

  await writeFile(path.join(target, "marker.bin"), Buffer.from([9]));
  await writeFile(
    path.join(target, "after-backup.txt"),
    "retained before restore",
  );
  const restored = await transfer("restore", backup);
  expect(path.resolve(restored.dataDir)).toBe(target);
  expect(await readFile(path.join(target, "marker.bin"))).toEqual(
    Buffer.from([0, 1, 2, 255]),
  );
  await expect(
    readFile(path.join(target, "after-backup.txt")),
  ).rejects.toThrow();
  expect(
    await readFile(
      path.join(restored.localDataResult.recoveryPath, "after-backup.txt"),
      "utf8",
    ),
  ).toBe("retained before restore");
  expect(
    (await invoke("players.list")).some((player) => player.name === "Data_QA"),
  ).toBe(true);
  checks.push(
    "Restore replaces current data after verification, preserves the original copy and reopens with the backed-up role",
  );

  const corrupt = path.join(root, "corrupt.zip");
  await writeFile(corrupt, "invalid archive");
  await expect(
    invoke("local-data.prepare", { kind: "restore", path: corrupt }),
  ).rejects.toThrow("ZIP");
  expect(await readFile(path.join(target, "marker.bin"))).toEqual(
    Buffer.from([0, 1, 2, 255]),
  );
  checks.push(
    "A malformed backup is refused while the current launcher and profile remain available",
  );
  await page.screenshot({ path: path.join(root, "desktop-result.png") });
  await writeFile(
    path.join(root, "verification.json"),
    JSON.stringify(
      { checks, root, restored: restored.localDataResult },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, root }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  // Match only the unique binary copied for this test, including its helper/restarted instances.
  await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:SFMCL_T_NATIVE_TEST_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ],
    {
      env: { ...process.env, SFMCL_T_NATIVE_TEST_EXE: binary },
      windowsHide: true,
    },
  );
  const key = createHash("sha256").update(`override:${source}`).digest("hex");
  // Remove only this test's saved location; never delete the shared control directory.
  for (const suffix of [".json", "-result.json"])
    await unlink(
      path.join(process.env.APPDATA, "SFMCL-T-data-locations", key + suffix),
    ).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
}
