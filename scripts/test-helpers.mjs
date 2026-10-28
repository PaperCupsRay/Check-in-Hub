/** 测试工具：Node 下加载 Worker，临时模块放系统/会话 scratch 并立即清理。 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function memoryKV(initial = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  const writes = [];
  return {
    data, writes,
    async get(key) { return data.get(key) ?? null; },
    async put(key, value, options) { writes.push({ key, options }); data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    read(key) { const value = data.get(key); return value == null ? null : JSON.parse(value); },
  };
}

export async function loadWorker() {
  const src = new URL("../src/index.js", import.meta.url);
  let code = await readFile(src, "utf8");
  code = code.replace(/^import uiHtml from "\.\/ui\.html";\r?$/m, 'const uiHtml = "<html></html>";');
  code = code.replace(/\bfrom "([^"]+)"/g, (_, spec) => {
    const url = spec.startsWith(".") ? new URL(spec, src).href : import.meta.resolve(spec);
    return `from "${url}"`;
  });
  const directory = await mkdtemp(path.join(process.env.PI_SCRATCH_DIR || tmpdir(), "checkin-worker-test-"));
  const target = path.join(directory, "worker.mjs");
  try {
    await writeFile(target, code);
    return await import(pathToFileURL(target).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
