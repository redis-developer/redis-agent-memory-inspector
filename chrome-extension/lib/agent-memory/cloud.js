/**
 * Cloud Agent Memory client - talks to Redis Cloud's Iris context engine.
 *
 * Same `/v1/stores/{storeId}/...` Data Plane API as the self-managed
 * backend, so the request/domain logic lives in the shared Data Plane
 * client. Cloud-specific bits handled here:
 *
 *   - Base URL routes through a proxy by default. Direct browser fetches to
 *     *.memory.redis.io trip Cloudflare's managed challenge; the proxy makes
 *     the call server-to-server where it isn't fingerprinted as bot traffic.
 *   - Auth is required: `Authorization: Bearer <apiKey>` on every request.
 *   - Health probe is a cheap authenticated session-memory listing (Cloud
 *     has no dedicated /health that clears the challenge).
 */

import { createDataPlaneClient } from "./data-plane.js";

/**
 * Default proxy URL for cloud traffic. The user can override per-connect via
 * the "Proxy URL" field (e.g. http://localhost:8787 for the local proxy).
 * Set to null to call Cloud directly (fails until Redis disables the managed
 * challenge on API endpoints). Wire shape: <PROXY>/<upstream-host>/<...path>
 */
const DEFAULT_CLOUD_PROXY_URL = "https://redis-agent-memory-inspector.vercel.app";

const HEADERS = (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
});

export function createCloudClient(config) {
    const { url, apiKey, storeId } = config;
    if (!apiKey) throw new Error("cloud client: config.apiKey is required");
    if (!storeId) throw new Error("cloud client: config.storeId is required");

    const cleanUrl = url.replace(/\/+$/, "");
    const upstreamHost = new URL(cleanUrl).host;
    const effectiveProxy = config.proxyUrl ?? DEFAULT_CLOUD_PROXY_URL;
    const root = effectiveProxy
        ? `${effectiveProxy.replace(/\/+$/, "")}/${upstreamHost}`
        : cleanUrl;
    const base = `${root}/v1/stores/${encodeURIComponent(storeId)}`;
    const headers = HEADERS(apiKey);

    async function ping() {
        // Listing one session confirms auth + host + storeId in one shot.
        try {
            const res = await fetch(
                `${base}/session-memory?limit=1&includeAll=true`,
                { headers },
            );
            if (res.ok) return { ok: true };
            const raw = await res.text();
            console.warn(
                `[Redis Agent Memory Cloud] health probe got ${res.status}; body:`,
                raw,
            );
            let detail = res.statusText;
            try {
                const body = JSON.parse(raw);
                detail = body.detail ?? body.title ?? body.message ?? detail;
            } catch {
                detail = raw ? raw.slice(0, 200) : detail;
            }
            return { ok: false, status: res.status, detail };
        } catch (err) {
            console.warn("[Redis Agent Memory Cloud] health probe threw:", err);
            return { ok: false, status: 0, detail: err.message };
        }
    }

    return createDataPlaneClient({
        backend: "cloud",
        base,
        headers,
        ping,
        supportsNamespaces: true,
    });
}
