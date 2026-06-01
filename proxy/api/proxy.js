/**
 * Transparent proxy for Redis Cloud Agent Memory, built on Express.
 *
 * Why this exists:
 *   Direct fetches to *.memory.redis.io from a Chrome extension are
 *   blocked by Cloudflare's managed challenge - the extension's TLS
 *   fingerprint + origin trips bot detection and a "Just a moment…"
 *   HTML page is returned instead of the API response. Server-to-server
 *   requests don't carry that profile, so we route through this proxy.
 *
 * Request shape:
 *   <method> https://<deploy-host>/<upstream-host>/<...rest>
 *
 *   The first path segment is the upstream Cloud host (e.g.
 *   "gcp-us-east4.memory.redis.io"). Everything after it - path, query,
 *   body - is forwarded verbatim to https://<upstream-host>/<rest>. The
 *   Authorization header passes through unchanged so the upstream sees
 *   the user's API key - the proxy holds no secrets of its own.
 *
 * Deploy:
 *   - Locally: `npm start --prefix proxy` (listens on :8787)
 *   - On Vercel: push the repo; Vercel auto-detects Express via the
 *     `express` dependency and wraps the default-exported app as a
 *     serverless function. `vercel.json` rewrites every URL to `/`.
 */

import express from "express";

const app = express();

// Strip the Vercel `/api/proxy` mount prefix if present, so internal
// routing sees the user-facing path (`/health`, `/<host>/<rest>`, etc.)
// whether or not Vercel preserved the original URL through the rewrite.
app.use((req, _res, next) => {
    if (req.url.startsWith("/api/proxy")) {
        req.url = req.url.slice("/api/proxy".length) || "/";
    }
    next();
});

// Capture the raw body for every Content-Type so we can forward POSTs
// (JSON, etc.) verbatim. 10mb cap is generous for any AMS payload.
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// CORS: the Chrome extension runs from a chrome-extension:// origin, so
// we need permissive cross-origin headers on every response (and a 204
// for the preflight OPTIONS).
app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept",
    );
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

const ALLOWED_HOST_SUFFIX = ".redis.io";

app.use(async (req, res) => {
    const segments = req.path.split("/").filter(Boolean);

    // Health check - independent of any upstream so uptime monitors /
    // smoke-tests can confirm the proxy itself is live.
    if (
        segments.length === 0 ||
        (segments.length === 1 &&
            (segments[0] === "health" || segments[0] === "healthz"))
    ) {
        return res.json({
            ok: true,
            service: "redis-agent-memory-inspector-proxy",
        });
    }

    if (segments.length < 2) {
        return res.status(400).json({
            error: "bad path",
            detail: `expected /<upstream-host>/<rest>; got ${req.path}`,
        });
    }

    const upstreamHost = segments[0];
    if (!upstreamHost.endsWith(ALLOWED_HOST_SUFFIX)) {
        // Stops the proxy being abused as an open relay.
        return res.status(403).json({
            error: "host not allowed",
            detail: `proxy only forwards to *${ALLOWED_HOST_SUFFIX}; got ${upstreamHost}`,
        });
    }

    const upstreamPath = "/" + segments.slice(1).join("/");
    const qIdx = req.originalUrl.indexOf("?");
    const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : "";
    const upstreamUrl = `https://${upstreamHost}${upstreamPath}${qs}`;

    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody && req.body?.length ? req.body : undefined;

    try {
        const upstream = await fetch(upstreamUrl, {
            method: req.method,
            headers: {
                Authorization: req.get("Authorization") ?? "",
                "Content-Type":
                    req.get("Content-Type") ?? "application/json",
                Accept: req.get("Accept") ?? "application/json",
            },
            body,
        });
        res.status(upstream.status);
        res.set(
            "Content-Type",
            upstream.headers.get("Content-Type") ?? "application/json",
        );
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.send(buf);
    } catch (err) {
        console.error("[proxy] upstream fetch failed:", err);
        res.status(502).json({ error: "upstream", detail: err.message });
    }
});

// Local dev only. On Vercel the module is imported to grab the default
// export - calling `listen` inside a serverless function would be wrong.
if (process.env.VERCEL !== "1") {
    const PORT = Number(process.env.PORT ?? 8787);
    app.listen(PORT, () => {
        console.log(`[proxy] listening on http://localhost:${PORT}`);
    });
}

export default app;
