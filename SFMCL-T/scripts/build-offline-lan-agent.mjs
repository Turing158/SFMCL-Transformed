import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectPath, runtimePath } from "./lib/paths.mjs";

const javaHome = process.env.SFMCL_T_AGENT_JDK || process.env.JAVA_HOME;
if (!javaHome) throw Error("Set SFMCL_T_AGENT_JDK to a JDK 17+ directory");
const output = runtimePath("offline-lan-agent");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(output, "build-"));
console.log(`Temporary agent build: ${temporary}`);
const classes = path.join(temporary, "classes");
mkdirSync(classes);
const run = (tool, args) => {
  const result = spawnSync(
    path.join(
      javaHome,
      "bin",
      `${tool}${process.platform === "win32" ? ".exe" : ""}`,
    ),
    args,
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0)
    throw Error(result.error?.message || result.stderr || result.stdout);
};
run("javac", [
  "--release",
  "8",
  "-encoding",
  "UTF-8",
  "-g:none",
  "-d",
  classes,
  projectPath("java/offline-lan/src/sfmcl/lan/OfflineLanAgent.java"),
]);
const manifest = path.join(temporary, "MANIFEST.MF");
writeFileSync(
  manifest,
  "Manifest-Version: 1.0\nPremain-Class: sfmcl.lan.OfflineLanAgent\nMain-Class: sfmcl.lan.OfflineLanAgent\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n",
);
const jar = projectPath("resources/offline-lan-agent.jar");
mkdirSync(path.dirname(jar), { recursive: true });
run("jar", [
  "--create",
  "--file",
  jar,
  "--manifest",
  manifest,
  "--date=2026-01-01T00:00:00Z",
  "-C",
  classes,
  ".",
]);
console.log(`Built embedded agent (${readFileSync(jar).length} bytes)`);
