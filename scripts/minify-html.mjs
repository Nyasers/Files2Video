// 最小化 HTML（占位）
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "..", "dist");
try {
  let html = readFileSync(join(dist, "index.html"), "utf-8");
  html = html.replace(/\s{2,}/g, " ").replace(/>\s+</g, "><").trim();
  writeFileSync(join(dist, "index.html"), html);
} catch {}