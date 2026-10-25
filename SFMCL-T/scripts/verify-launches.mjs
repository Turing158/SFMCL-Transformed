import { runtimePath } from "./lib/paths.mjs";
import { chromium } from "playwright";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const browser = await chromium.connectOverCDP(
  process.env.SFMCL_T_CDP || "http://127.0.0.1:9422",
);
const page = browser.contexts()[0].pages()[0];
const invoke = (operation, payload = {}) =>
  page.evaluate(
    ({ operation, payload }) =>
      window.__TAURI_INTERNALS__.invoke("request", { operation, payload }),
    { operation, payload },
  );
const original = (await invoke("bootstrap")).settings;
if (
  !path
    .resolve(original.activeDir)
    .startsWith(runtimePath() + path.sep)
)
  throw new Error("Verification requires a .runtime game directory");
const jres = [];
for (const kind of ["java8", "java17"]) {
  for (const name of await readdir(runtimePath(kind)))
    if (name.startsWith("jdk"))
      jres.push(runtimePath(`${kind}/${name}/bin/java.exe`));
}
const only = process.argv.slice(2);
const versions = (await invoke("versions.list")).filter(
  (v) =>
    (v.id === "1.20.1" || v.id.startsWith("verify-")) &&
    (!only.length || only.some((k) => v.id.includes(k))),
);
const results = [];
try {
  for (const version of versions) {
    await invoke("settings.save", {
      ...original,
      activeVersion: version.id,
      javaPath: "",
      javaPaths: jres,
      memoryMb: 2048,
      autoMemory: false,
    });
    const id = await invoke("launch");
    console.log(`Launch ${version.id}: ${id}`);
    const deadline = Date.now() + 180_000;
    let lastStep;
    let evidence;
    let renderedAt;
    while (Date.now() < deadline) {
      const tasks = await invoke("tasks");
      const job = tasks.jobs.find((j) => j.id === id);
      if (!job) throw new Error("Desktop restarted during launch verification");
      evidence = job;
      if (job.currentStep !== lastStep) {
        console.log(`${version.id}: step ${job.currentStep}, ${job.status}`);
        lastStep = job.currentStep;
      }
      if (["failed", "cancelled", "completed"].includes(job.status)) break;
      const log = job.log.join("\n");
      if (
        /Created:.*(?:textures\/atlas|texture-atlas)|Created:.*-atlas|Sound engine started/i.test(
          log,
        )
      )
        renderedAt ||= Date.now();
      if (renderedAt && Date.now() - renderedAt > 8000) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const rendered = Boolean(renderedAt) && evidence.status === "running";
    console.log(
      JSON.stringify({
        version: version.id,
        rendered,
        status: evidence.status,
        error: evidence.error,
        lastLog: evidence.log.slice(-8),
      }),
    );
    await invoke("jobs.cancel", { id });
    for (let i = 0; i < 30; i++) {
      const job = (await invoke("tasks")).jobs.find((j) => j.id === id);
      if (["cancelled", "completed", "failed"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    results.push({ version: version.id, rendered, job: evidence });
    await writeFile(
      runtimePath(
        `evidence/launches${only.length ? `-${only.join("-")}` : ""}.json`,
      ),
      JSON.stringify(results, null, 2),
    );
  }
} finally {
  await invoke("settings.save", original);
  await browser.close();
}
if (results.some((r) => !r.rendered)) process.exitCode = 1;
