import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url),
  viteRequire = createRequire(require.resolve("vite"));
const { build } = await import(
  pathToFileURL(viteRequire.resolve("esbuild")).href
);
export async function loadApi(mode: "mock" | "http", base?: string) {
  const root = new URL("../tmp/", import.meta.url),
    dir = new URL("workflow-" + randomUUID() + "/", root);
  await mkdir(dir, { recursive: true });
  const outfile = new URL("api.mjs", dir);
  await build({
    entryPoints: [fileURLToPath(new URL("../src/api.ts", import.meta.url))],
    outfile: fileURLToPath(outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    define: {
      "import.meta.env": JSON.stringify({
        VITE_API_MODE: mode,
        VITE_API_BASE_URL: base,
        PROD: false,
      }),
    },
  });
  const module = await import(outfile.href);
  return {
    ...module,
    cleanup: async () => {
      if (!fileURLToPath(dir).startsWith(fileURLToPath(root)))
        throw new Error("Unexpected fixture path");
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, String(v));
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() {
      return values.size;
    },
    values,
  };
}
export function installStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage(),
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage(),
    configurable: true,
  });
}
