/**
 * Local development server: serves chrome-extension/ as a plain website
 * and proxies /v1/* to a Redis Agent Memory server, so the inspector can
 * be developed in a normal browser tab (no extension reload loop, no
 * CORS - the page and the API share this origin).
 *
 *   node dev-server.mjs [port] [agent-memory-url]
 *
 * Defaults: port 9871, agent memory at http://localhost:8000. Connect
 * with backend "oss" and url http://localhost:<port>.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 9871);
const UPSTREAM = process.argv[3] ?? "http://localhost:8000";
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "chrome-extension");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
};

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/v1/")) {
        try {
            const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
                method: req.method,
                headers: { "content-type": req.headers["content-type"] ?? "application/json" },
                body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
                duplex: "half",
            });
            res.writeHead(upstream.status, {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
            });
            res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: `proxy: ${err.message}` }));
        }
        return;
    }

    const path = url.pathname === "/" ? "/inspector.html" : url.pathname;
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
}).listen(PORT, () => {
    console.log(`inspector dev server: http://localhost:${PORT}/inspector.html (proxying /v1 -> ${UPSTREAM})`);
});
