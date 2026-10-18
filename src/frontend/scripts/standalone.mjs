import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = await import(
  pathToFileURL(viteRequire.resolve("esbuild")).href
);
const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
  outdir: fileURLToPath(new URL("../tmp/standalone/", import.meta.url)),
  bundle: true,
  loader: { ".png": "dataurl", ".webm": "dataurl" },
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define: {
    "import.meta.env": JSON.stringify({ VITE_API_MODE: "mock" }),
    "process.env.NODE_ENV": '"production"',
  },
});
const js = result.outputFiles
  .find((f) => f.path.endsWith(".js"))
  .text.replace(/<\/script/gi, "<\\/script");
const css = result.outputFiles
  .find((f) => f.path.endsWith(".css"))
  .text.replace(/@import\s*(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*;/g, "");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101a2d"><title>夜航 Night Voyage · 离线演示</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
writeFileSync(new URL("../夜航-交互预览.html", import.meta.url), html);
console.log(
  "离线交互预览已生成：夜航-交互预览.html（固定为mock模式，无需服务器）",
);
