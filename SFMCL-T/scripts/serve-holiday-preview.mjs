import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.dirname(project);
const profile = path.join(repository, ".runtime/dev-data");
const readJson = async (file, fallback) => {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch { return fallback; }
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
async function snapshot() {
  const settings = await readJson(path.join(profile, "settings.json"), {});
  const players = await readJson(path.join(profile, "players.json"), []);
  const cache = await readJson(path.join(profile, "cache/official-notices.json"), {});
  const custom = await readJson(path.join(profile, "Notices.json"), []);
  const hidden = await readJson(path.join(profile, "HiddenNotices.json"), []);
  const notices = [...Object.values(cache).flatMap(value => value.items || []), ...custom];
  const versionsRoot = path.join(settings.activeDir || profile, ".minecraft/versions");
  const entries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const versions = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const metadata = await readJson(path.join(versionsRoot, entry.name, `${entry.name}.json`), {});
    const libraries = JSON.stringify(metadata.libraries || []);
    return { id: entry.name, version: metadata.inheritsFrom || metadata.id || entry.name, kind: metadata.type || "release", loader: /fabric-loader/.test(libraries) ? "Fabric" : /neoforge/.test(libraries) ? "NeoForge" : /minecraftforge/.test(libraries) ? "Forge" : "Vanilla", path: path.join(versionsRoot, entry.name), javaMajor: metadata.javaVersion?.majorVersion || 21, icon: "" };
  }));
  if (!versions.length && settings.activeVersion) versions.push({ id: settings.activeVersion, version: settings.activeVersion, kind: "release", loader: "Vanilla", path: path.join(versionsRoot, settings.activeVersion), javaMajor: 21, icon: "" });
  return {
    settings: pick(settings, ["onboardingVersion", "gameDirs", "activeDir", "activeVersion", "activePlayer", "theme", "accent", "homeCleanMode", "homeNoticeLayout", "backgroundType", "background", "backgroundOverlayOpacity", "backgroundBlur", "downloadTaskDisplay", "autoMemory", "memoryMb", "isolation", "playerPreviewMode", "player3dFps"]),
    players: (Array.isArray(players) ? players : players.players || []).map(player => pick(player, ["uuid", "name", "online", "slim", "skin", "cape", "accountType", "serverName"])),
    versions, notices, hidden,
    home: await readJson(path.join(profile, "HomeContent.json"), { schemaVersion: 1, widgets: [] }),
  };
}
const visual = await snapshot();
const imagePaths = [...new Set(visual.players.flatMap(player => [player.skin, player.cape]).filter(Boolean))];
if (["local", "remote"].includes(visual.settings.backgroundType) && visual.settings.background) imagePaths.push(visual.settings.background);
const imageCache = new Map();
async function previewImage(index) {
  const source = imagePaths[index];
  if (!source) return "";
  if (!imageCache.has(source)) imageCache.set(source, (async () => {
    try {
      let bytes, type;
      if (/^https?:/.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return "";
        type = (response.headers.get("content-type") || "").split(";")[0];
        if (!/^image\/(png|jpeg|webp)$/.test(type)) return "";
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(source).toLowerCase()];
        if (!type) return "";
        bytes = await readFile(source);
      }
      return bytes.length <= 5 * 1024 * 1024 ? `data:${type};base64,${bytes.toString("base64")}` : "";
    } catch { return ""; }
  })());
  return imageCache.get(source);
}
const mime = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".css": "text/css", ".mjs": "text/javascript", ".ico": "image/x-icon" };
const server = await createServer({
  configFile: false, root: project, plugins: [react(), {
    name: "holiday-preview-files",
    resolveId(id) { if (id === "virtual:holiday-profile") return "\0holiday-profile"; },
    load(id) { if (id === "\0holiday-profile") return `export default ${JSON.stringify(visual)};`; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const pathname = decodeURIComponent((request.url || "").split("?")[0]);
        if (pathname === "/__holiday-image") {
          const index = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("index"));
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          return response.end(Number.isInteger(index) ? await previewImage(index) : "");
        }
        if (!pathname.startsWith("/design-previews/")) return next();
        const directory = path.join(repository, "design-previews");
        const file = path.resolve(repository, `.${pathname}`);
        if (!file.startsWith(directory + path.sep) || !mime[path.extname(file)]) { response.statusCode = 404; return response.end(); }
        try { const bytes = await readFile(file); response.setHeader("Content-Type", mime[path.extname(file)]); response.setHeader("Cache-Control", "no-store"); response.end(bytes); }
        catch { response.statusCode = 404; response.end("Preview file not found"); }
      });
    },
  }], server: { host: "127.0.0.1", port: 4876, strictPort: true, fs: { allow: [project, path.join(repository, "design-previews")], deny: ["**/.runtime/**", "**/target/**", "**/credentials.dat", "**/.env*", "**/.git/**"] }, watch: { ignored: ["**/target/**", "**/.runtime/**", "**/design-previews/*.jpg"] } },
});
await server.listen();
console.log("Holiday preview: http://127.0.0.1:4876/design-previews/holiday-accessories.html");
