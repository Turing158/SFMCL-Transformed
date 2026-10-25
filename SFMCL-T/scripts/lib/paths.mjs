import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this module so npm and direct Node invocations use the same paths.
const projectRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const runtimeRoot = path.resolve(
  fileURLToPath(new URL("../../../.runtime/", import.meta.url)),
);

export const projectPath = (...segments) => path.join(projectRoot, ...segments);
export const runtimePath = (...segments) => path.join(runtimeRoot, ...segments);
