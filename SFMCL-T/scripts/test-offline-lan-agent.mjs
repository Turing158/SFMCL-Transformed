import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { projectPath, runtimePath } from "./lib/paths.mjs";

const javaHome = process.env.SFMCL_T_AGENT_JDK || process.env.JAVA_HOME;
if (!javaHome) throw Error("Set SFMCL_T_AGENT_JDK to a JDK 17+ directory");
const output = runtimePath("offline-lan-agent");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(output, "test-"));
console.log(`Temporary agent tests: ${temporary}`);
const agent = projectPath("resources/offline-lan-agent.jar");
const run = (tool, args, allowedFailure = false) => {
  const result = spawnSync(
    path.join(
      javaHome,
      "bin",
      `${tool}${process.platform === "win32" ? ".exe" : ""}`,
    ),
    args,
    { encoding: "utf8", cwd: temporary, windowsHide: true, timeout: 60000 },
  );
  if (!allowedFailure && result.status !== 0)
    throw Error(result.error?.message || result.stderr || result.stdout);
  return result;
};
const source = (name, text) => {
  const filename = path.join(temporary, name);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, text);
  return filename;
};
const checks = [];
for (const override of [false, true]) {
  const classes = path.join(temporary, `classes-${override}`);
  mkdirSync(classes);
  const files = [
    source(
      "MinecraftServer.java",
      "package net.minecraft.server; public class MinecraftServer { public boolean usesAuthentication() { return true; } }",
    ),
    source(
      "IntegratedServer.java",
      `package net.minecraft.client.server; public class IntegratedServer extends net.minecraft.server.MinecraftServer { ${override ? "public boolean usesAuthentication() { return true; }" : ""} }`,
    ),
    source(
      "Check.java",
      'public class Check { public static void main(String[] args) { boolean offline=Boolean.parseBoolean(args[0]); if(new net.minecraft.client.server.IntegratedServer().usesAuthentication()==offline || !new net.minecraft.server.MinecraftServer().usesAuthentication()) throw new AssertionError(); System.out.println("Scope OK"); } }',
    ),
  ];
  run("javac", ["--release", "8", "-d", classes, ...files]);
  const jar = path.join(temporary, `fixture-${override}.jar`);
  run("jar", ["cf", jar, "-C", classes, "."]);
  const target = run("java", [
    "-cp",
    agent,
    "sfmcl.lan.OfflineLanAgent",
    "--check",
    jar,
  ]).stdout.trim();
  for (const enabled of [false, true]) {
    assert.match(
      run("java", [
        ...(enabled ? [`-javaagent:${agent}=${target}`] : []),
        "-cp",
        classes,
        "Check",
        String(enabled),
      ]).stdout,
      /Scope OK/,
    );
  }
  checks.push(
    `Java 8 class file: inherited/existing override=${override}, opt-in and server scope`,
  );
}
const missing = path.join(temporary, "missing.jar");
run("jar", [
  "cf",
  missing,
  "-C",
  path.join(temporary, "classes-false"),
  "Check.class",
]);
assert.notEqual(
  run(
    "java",
    ["-cp", agent, "sfmcl.lan.OfflineLanAgent", "--check", missing],
    true,
  ).status,
  0,
);
checks.push("Unsupported classes rejected before game launch");

const classes = path.join(temporary, "obfuscated");
mkdirSync(classes);
run("javac", [
  "--release",
  "8",
  "-d",
  classes,
  source("a.java", "public class a { public boolean x() { return true; } }"),
  source("b.java", "public class b extends a {}"),
  source(
    "MappedCheck.java",
    'public class MappedCheck { public static void main(String[] args) { if(new b().x() || !new a().x()) throw new AssertionError(); System.out.println("Mappings OK"); } }',
  ),
]);
const jar = path.join(temporary, "mapped.jar");
run("jar", ["cf", jar, "-C", classes, "."]);
const mappings = source(
  "client-mappings.txt",
  "net.minecraft.server.MinecraftServer -> a:\n    10:11:boolean usesAuthentication() -> x\nnet.minecraft.client.server.IntegratedServer -> b:\n",
);
const target = run("java", [
  "-cp",
  agent,
  "sfmcl.lan.OfflineLanAgent",
  "--check",
  jar,
  mappings,
]).stdout.trim();
assert.equal(target, "a,b,x");
assert.match(
  run("java", [`-javaagent:${agent}=${target}`, "-cp", classes, "MappedCheck"])
    .stdout,
  /Mappings OK/,
);
checks.push("Official obfuscated class/method mappings");

const metadataPath = process.env.SFMCL_T_LAN_TEST_VERSION;
if (metadataPath) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const versionDirectory = path.dirname(metadataPath);
  const gameRoot = path.resolve(versionDirectory, "../..");
  const jarId = metadata.jar || metadata.id;
  const client = path.join(gameRoot, "versions", jarId, `${jarId}.jar`);
  const target = run("java", [
    "-cp",
    agent,
    "sfmcl.lan.OfflineLanAgent",
    "--check",
    client,
  ]).stdout.trim();
  const actualClasses = path.join(temporary, "actual");
  mkdirSync(actualClasses);
  run("javac", [
    "--release",
    "8",
    "-d",
    actualClasses,
    projectPath("java/offline-lan/tests/ActualProbe.java"),
  ]);
  const classpath = [
    actualClasses,
    client,
    ...metadata.libraries
      .map((library) => library.downloads?.artifact?.path)
      .filter(Boolean)
      .map((relative) => path.join(gameRoot, "libraries", relative))
      .filter(existsSync),
  ].join(path.delimiter);
  for (const enabled of [false, true]) {
    const result = run("java", [
      ...(enabled ? [`-javaagent:${agent}=${target}`] : []),
      "-Djava.awt.headless=true",
      "-cp",
      classpath,
      "ActualProbe",
      String(enabled),
    ]);
    assert.match(
      result.stdout,
      /Actual Minecraft: integrated=(KEY|VERIFYING), dedicated=KEY/,
    );
    console.log(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => /Actual Minecraft|SFMCL Offline/.test(line))
        .join("\n"),
    );
  }
  checks.push(
    `Actual ${metadata.id} offline login handshake and dedicated server control`,
  );
}
writeFileSync(
  path.join(output, "report.json"),
  JSON.stringify({ temporary, checks }, null, 2),
);
console.log(checks.join("\n"));
