import { runtimePath } from "./lib/paths.mjs";
import { chromium } from "playwright";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
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
const root = runtimePath("smoke-game/.minecraft");
const catalogs = JSON.parse(
  await readFile(runtimePath("evidence/catalogs.json"), "utf8"),
);
const optifine = catalogs
  .find((c) => c.kind === "OptiFine")
  .choices.find((c) => c.version === "HD_U_I6");
const forgeVersion = optifine.metadata.forge.trim().replace(/^Forge\s*/, "");
const forge = catalogs
  .find((c) => c.kind === "Forge")
  .choices.find((c) => c.version === forgeVersion);
if (!forge) throw new Error(`Missing compatible Forge ${forgeVersion}`);
const fabric = catalogs.find((c) => c.kind === "Fabric").choices[0];
const apiFiles = await invoke("resources.files", {
  source: "modrinth",
  id: "P7dR8mSH",
  gameVersion: "1.20.1",
  loader: "Fabric",
});
const requests = [
  {
    name: "verify-forge-optifine-1.20.1",
    loader: forge,
    optifine,
    fabricApi: null,
  },
  {
    name: "verify-fabric-api-1.20.1",
    loader: fabric,
    optifine: null,
    fabricApi: apiFiles[0].file,
  },
];
const results = [];
try {
  for (const request of requests) {
    if ((await invoke("versions.list")).some((v) => v.id === request.name))
      continue;
    await mkdir(path.join(root, "versions", request.name), { recursive: true });
    await copyFile(
      path.join(root, "versions/1.20.1/1.20.1.jar"),
      path.join(root, "versions", request.name, `${request.name}.jar`),
    );
    const id = await invoke("install", {
      root,
      minecraft: "1.20.1",
      ...request,
    });
    console.log(`Installing ${request.name} (${request.loader.version})`);
    let result;
    for (let i = 0; i < 300; i++) {
      const tasks = await invoke("tasks");
      const job = tasks.jobs.find((j) => j.id === id);
      if (!job) throw new Error("Desktop restarted during addon installation");
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        result = {
          name: request.name,
          loader: request.loader.version,
          optifine: request.optifine?.version,
          fabricApi: request.fabricApi?.path,
          job,
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!result || result.job.status !== "completed")
      await invoke("jobs.cancel", { id });
    results.push(result || { name: request.name, error: "Timed out" });
    console.log(
      JSON.stringify({
        name: request.name,
        status: result?.job.status,
        error: result?.job.error,
      }),
    );
    await writeFile(
      runtimePath("evidence/addon-installs.json"),
      JSON.stringify(results, null, 2),
    );
  }
} finally {
  await browser.close();
}
if (results.some((r) => r.job?.status !== "completed")) process.exitCode = 1;
