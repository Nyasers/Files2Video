// 生成 hash manifest（占位）
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "..", "dist");
const manifest = {};
try {
  const { readFileSync, readdirSync } = await import("fs");
  const files = readdirSync(dist);
  for (const f of files) {
    if (f === "sw.js") continue; // SW 自身不需要缓存
    if (f.endsWith(".html") || f.endsWith(".js") || f.endsWith(".css")) {
      const buf = readFileSync(join(dist, f));
      manifest[f] = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    }
  }
} catch {}
writeFileSync(join(dist, "hashes.json"), JSON.stringify(manifest));