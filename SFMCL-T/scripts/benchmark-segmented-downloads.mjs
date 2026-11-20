import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { projectPath, runtimePath } from "./lib/paths.mjs";

const mib = 1048576;
const evidence = runtimePath("segmented-downloads");
const scratch = projectPath("target/tmp/segmented-benchmark-20261120");
const exe = projectPath(
  "target/debug/examples/benchmark_segmented_downloads.exe",
);
await mkdir(evidence, { recursive: true });
await mkdir(scratch, { recursive: true });
console.log(`Recorded test scratch: ${scratch}`);
const pattern = Buffer.alloc(251 * 512);
for (let i = 0; i < pattern.length; i++) pattern[i] = i % 251;
const chunkSize = 251 * 256;
const data = (start, length) =>
  pattern.subarray(start % 251, (start % 251) + length);
function hash(size) {
  const hash = createHash("sha1");
  for (let start = 0; start < size; start += chunkSize)
    hash.update(data(start, Math.min(chunkSize, size - start)));
  return hash.digest("hex");
}
let active = 0,
  peak = 0,
  requests = [];
const server = createServer(async (req, res) => {
  const size = Number(req.url.split("/")[1]);
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  let start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : size - 1;
  requests.push({ url: req.url, range: req.headers.range ?? null });
  if (!size || start > end || end >= size) {
    res.writeHead(416).end();
    return;
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Length": end - start + 1,
    ETag: `"fixture-${size}"`,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  active++;
  peak = Math.max(peak, active);
  res.once("close", () => active--);
  try {
    while (start <= end && !res.destroyed) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (res.destroyed) break;
      const length = Math.min(chunkSize, end - start + 1);
      if (!res.write(data(start, length))) {
        await new Promise((resolve) => {
          const finish = () => {
            res.off("drain", finish);
            res.off("close", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
        });
      }
      start += length;
    }
    res.end();
  } catch {
    res.destroy();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const rows = [];
async function run(source, segments, spec, count, mode) {
  const files = Array.from({ length: count }, (_, i) => ({
    ...spec,
    path: `file-${i}.bin`,
  }));
  const manifest = path.join(evidence, "benchmark-input.json");
  await writeFile(
    manifest,
    JSON.stringify({ mode, files, connectionLimit: 16 }),
  );
  peak = 0;
  requests = [];
  const child = spawn(exe, [manifest], {
    env: { ...process.env, TEMP: scratch, TMP: scratch },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const [code] = await once(child, "exit");
  const line = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  const result = line ? JSON.parse(line) : { error: stderr.trim() };
  const sha256Matches = spec.sha256
    ? result.sha256?.length === count &&
      result.sha256.every((v) => v === spec.sha256)
    : undefined;
  const row = {
    source,
    targetSegments: segments,
    ...result,
    exitCode: sha256Matches === false ? 1 : code,
    ...(spec.sha256 ? { sha256Matches } : {}),
    ...(source === "local"
      ? { peakConnections: peak, requests: [...requests] }
      : { url: spec.url }),
    ...(stderr ? { stderr: stderr.trim() } : {}),
  };
  rows.push(row);
  await writeFile(
    path.join(evidence, "benchmark-results.json"),
    JSON.stringify(rows, null, 2),
  );
  console.log(
    JSON.stringify({ ...row, requests: undefined, stderr: undefined }),
  );
  return row.exitCode === 0;
}
async function json(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { "User-Agent": "SFMCL-T verification" },
  });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}
try {
  if (!process.argv.includes("--remote-only")) {
    for (const [size, segments] of [
      [4 * mib, 4],
      [8 * mib + 1, 8],
      [64 * mib + 1, 10],
    ]) {
      const spec = {
        url: `${origin}/${size}/file.bin`,
        size,
        sha1: hash(size),
      };
      for (const count of [1, 2])
        for (const mode of ["plain", "segmented"])
          await run("local", segments, spec, count, mode);
    }
  }
  if (
    process.argv.includes("--remote") ||
    process.argv.includes("--remote-only")
  ) {
    const catalog = await json(
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    );
    const version = await json(
      catalog.versions.find((v) => v.id === "1.21.4").url,
    );
    const library = version.libraries
      .map((v) => v.downloads?.artifact)
      .find((v) => v?.size >= mib && v.size <= 8 * mib);
    const client = version.downloads.client;
    const java = await fetch(
      "https://corretto.aws/downloads/latest/amazon-corretto-8-x64-windows-jdk.zip",
      {
        headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(30000),
      },
    );
    const javaSize = Number(java.headers.get("content-range")?.split("/")[1]);
    const javaUrl = java.url;
    await java.body.cancel();
    if (java.status !== 206 || javaSize <= 64 * mib)
      throw new Error("Invalid Java range probe");
    const checksum = await fetch(
      "https://corretto.aws/downloads/latest_sha256/amazon-corretto-8-x64-windows-jdk.zip",
      { signal: AbortSignal.timeout(30000) },
    );
    const javaSha256 = (await checksum.text()).match(/[a-f0-9]{64}/i)?.[0];
    if (!checksum.ok || !javaSha256)
      throw new Error("Official Java checksum unavailable");
    const samples = [
      [4, { url: library.url, size: library.size, sha1: library.sha1 }],
      [8, { url: client.url, size: client.size, sha1: client.sha1 }],
      [
        10,
        {
          url: javaUrl,
          size: javaSize,
          sha256: javaSha256,
        },
      ],
    ];
    await writeFile(
      path.join(evidence, "remote-samples.json"),
      JSON.stringify(
        {
          minecraftVersion: "1.21.4",
          samples,
          javaSha256,
        },
        null,
        2,
      ),
    );
    for (const [segments, spec] of samples) {
      let failed = false;
      for (const count of [1, 2]) {
        for (const mode of ["plain", "segmented"]) {
          if (!(await run("remote", segments, spec, count, mode))) {
            failed = true;
            break;
          }
        }
        if (failed) break;
      }
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const cleanup = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      projectPath("../clean-target.ps1"),
      "-TestArtifactPaths",
      scratch,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  console.log(cleanup.stdout.trim());
  if (cleanup.status !== 0)
    throw new Error(cleanup.stderr || "Scratch cleanup failed");
}
if (rows.some((row) => row.exitCode !== 0)) process.exitCode = 1;
