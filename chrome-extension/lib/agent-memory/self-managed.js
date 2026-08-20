/**
 * Self-managed Agent Memory client - talks to a self-hosted Iris Data Plane
 * you run yourself (Kubernetes/Helm). It exposes the same
 * `/v1/stores/{storeId}/...` API as Cloud, so it reuses the shared Data
 * Plane client. What differs from Cloud:
 *
 *   - Base URL is your own Data Plane endpoint, called directly (no
 *     Cloudflare proxy). An optional proxy URL is still honored for
 *     environments where the browser can't reach the endpoint directly.
 *   - Auth is configurable: none (auth-disabled static store), a Bearer
 *     agent key, or an X-Api-Key gateway credential.
 *   - Health is the dedicated GET /health endpoint at the Data Plane root.
 */

import { createDataPlaneClient } from "./data-plane.js";

/** Build request headers for the selected auth mode. */
function authHeaders(auth) {
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    const method = auth?.method ?? "none";
    const credential = auth?.credential;
    if (method === "none" || !credential) return headers;
    if (method === "x-api-key") return { ...headers, "X-Api-Key": credential };
    return { ...headers, Authorization: `Bearer ${credential}` };
}

export function createSelfManagedClient(config) {
    const { url, storeId } = config;
    if (!url) throw new Error("self-managed client: config.url is required");
    if (!storeId) {
        throw new Error("self-managed client: config.storeId is required");
    }

    const cleanUrl = url.replace(/\/+$/, "");
    // Optional proxy passthrough (same <PROXY>/<host>/... shape as Cloud) for
    // environments where the browser can't reach the endpoint directly.
    const root = config.proxyUrl
        ? `${config.proxyUrl.replace(/\/+$/, "")}/${new URL(cleanUrl).host}`
        : cleanUrl;
    const base = `${root}/v1/stores/${encodeURIComponent(storeId)}`;
    const headers = authHeaders(config.auth);
    // /health lives at the Data Plane root, not under the store path.
    const healthUrl = `${root}/health`;

    async function ping() {
        try {
            const res = await fetch(healthUrl, { headers });
            if (res.ok) return { ok: true };
            const raw = await res.text();
            let detail = res.statusText;
            try {
                const body = JSON.parse(raw);
                detail = body.detail ?? body.title ?? body.message ?? detail;
            } catch {
                detail = raw ? raw.slice(0, 200) : detail;
            }
            return { ok: false, status: res.status, detail };
        } catch (err) {
            return { ok: false, status: 0, detail: err.message };
        }
    }

    return createDataPlaneClient({
        backend: "self-managed",
        base,
        headers,
        ping,
        supportsNamespaces: true,
    });
}
