import { runtimePath } from "./lib/paths.mjs";
import { chromium } from "playwright";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9422");
const page = browser.contexts()[0].pages()[0];
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const root = runtimePath("smoke-game/.minecraft");
const catalogs = JSON.parse(
  await readFile(runtimePath("evidence/catalogs.json"), "utf8"),
);
const results = [];
const only = process.argv.slice(2);
for (const catalog of catalogs.filter(
  (c) => !only.length || only.includes(c.kind),
)) {
  if (!catalog.choices?.length) continue;
  const { kind, minecraft } = catalog;
  const stable = catalog.choices.filter(
    (c) => !/beta|alpha|pre|snapshot/i.test(c.version),
  );
  const choices = stable.length ? stable : catalog.choices;
  choices.sort((a, b) =>
    b.version.localeCompare(a.version, "en", { numeric: true }),
  );
  const loader = choices[0];
  const name = `verify-${kind.toLowerCase()}-${minecraft}`;
  let jobId;
  try {
    const installed = await invoke("versions.list");
    if (installed.some((v) => v.id === name)) {
      console.log(`${kind}: already installed`);
      continue;
    }
    await mkdir(path.join(root, "versions", name), { recursive: true });
    if (minecraft === "1.20.1")
      await copyFile(
        path.join(root, "versions", minecraft, `${minecraft}.jar`),
        path.join(root, "versions", name, `${name}.jar`),
      );
    jobId = await invoke("install", {
      root,
      minecraft,
      name,
      loader,
      optifine: null,
      fabricApi: null,
    });
    console.log(`${kind} ${loader.version}: started ${jobId}`);
    const deadline = Date.now() + 15 * 60_000;
    let lastProgress = "";
    while (Date.now() < deadline) {
      const tasks = await invoke("tasks");
      const job = tasks.jobs.find((j) => j.id === jobId);
      if (!job) throw new Error("Desktop restarted; installation interrupted");
      const batch = tasks.downloads.find((d) => d.id === job.downloadId);
      const progress = JSON.stringify({
        kind,
        step: job.currentStep,
        status: job.status,
        files: batch && `${batch.completed}/${batch.fileCount}`,
        mb: batch && Math.round(batch.downloaded / 1048576),
      });
      if (progress !== lastProgress) {
        console.log(progress);
        lastProgress = progress;
      }
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        const files =
          batch?.status === "failed"
            ? await invoke("downloads.files", { id: batch.id })
            : [];
        results.push({
          kind,
          minecraft,
          loader: loader.version,
          job,
          batch,
          failedFiles: files.filter((f) => f.status === "failed"),
        });
        if (job.status !== "completed")
          await invoke("jobs.cancel", { id: jobId });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!results.some((r) => r.kind === kind)) {
      await invoke("jobs.cancel", { id: jobId });
      results.push({ kind, error: "15 minute verification timeout" });
    }
  } catch (error) {
    results.push({ kind, error: String(error) });
    if (jobId) await invoke("jobs.cancel", { id: jobId }).catch(() => {});
    console.log(`${kind}: ${error}`);
  }
  await writeFile(
    runtimePath(
      `evidence/loader-installs${only.length ? `-${only.join("-")}` : ""}.json`,
    ),
    JSON.stringify(results, null, 2),
  );
}
await browser.close();
if (results.some(result => result.error || result.job?.status !== "completed")) {
  process.exitCode = 1;
}
