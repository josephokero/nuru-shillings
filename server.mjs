import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8765;

const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const routes = {
  "/api/chat": () => import("./api/chat.js"),
  "/api/contact": () => import("./api/contact.js"),
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 600_000) break;
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[url.pathname];
  if (route) {
    req.body = req.method === "POST" ? await readJson(req) : {};
    const { default: handler } = await route();
    return handler(req, res);
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
    req.body = req.method === "POST" ? await readJson(req) : {};
    url.searchParams.set("route", url.pathname.replace(/^\/api\//, "").replace(/^\//, ""));
    req.url = `/api/nsh?${url.searchParams}`;
    const { default: handler } = await import("./api/nsh.js");
    return handler(req, res);
  }

  const clean = url.pathname.replace(/\/index\.html$|\.html$/, "").replace(/(.)\/+$/, "$1") || "/";
  if (clean !== url.pathname) {
    res.statusCode = 301;
    res.setHeader("Location", clean + url.search + url.hash);
    return res.end();
  }

  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root) || /[\\/](\.env|api[\\/]_)/.test(file.slice(root.length))) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  if (!path.extname(file) && existsSync(file + ".html")) file += ".html";
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(port, () => console.log(`Nora Shillings on http://localhost:${port}`));
