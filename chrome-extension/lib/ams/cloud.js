/**
 * Cloud Agent Memory client - talks to Redis Cloud's Iris context engine.
 *
 * Endpoint shape (verified against a live store):
 *
 *   GET    /v1/stores/{storeId}/session-memory               (list session IDs)
 *   GET    /v1/stores/{storeId}/session-memory/{sessionId}   (full session memory)
 *   POST   /v1/stores/{storeId}/session-memory/events        (append one event)
 *   DELETE /v1/stores/{storeId}/session-memory/{sessionId}   (wipe session)
 *   POST   /v1/stores/{storeId}/long-term-memory             (bulk create)
 *   POST   /v1/stores/{storeId}/long-term-memory/search      (semantic search)
 *   DELETE /v1/stores/{storeId}/long-term-memory             (body: { memoryIds: [...] })
 *
 * Auth: required. `Authorization: Bearer <apiKey>` on every request.
 *
 * Field translation (cloud → OSS shape that the rest of the inspector
 * expects):
 *
 *   memoryType  → memory_type
 *   ownerId     → user_id
 *   sessionId   → session_id
 *   createdAt   → created_at
 *   updatedAt   → updated_at
 *   namespace   → not a thing on cloud; always null
 *
 *   For working-memory events:
 *     event.content[0].text       → message.content
 *     event.role ("USER"/"ASSIST") → message.role ("user"/"assistant")
 *     event.eventId               → message.id
 *     event.createdAt             → message.created_at
 *     event.actorId               → (no OSS equivalent - dropped)
 *
 * Things Cloud does NOT return that OSS does (so the inspector's behavior
 * will degrade gracefully for cloud):
 *   - `score` / `dist` on search results - Cloud's search response has no
 *     similarity score, so the score badge on LTM cards never renders.
 *   - `discrete_memory_extracted` on events - the per-message extraction
 *     flag isn't present; the "extracted" / "pending" pill never shows.
 *   - `summary` on session memory - Cloud doesn't appear to surface one.
 */

const NS = null; // cloud has no namespace concept

/**
 * Default proxy URL for cloud traffic. Direct browser fetches to
 * *.memory.redis.io trip Cloudflare's managed challenge - the proxy makes
 * the call server-to-server where it isn't fingerprinted as bot traffic.
 *
 * The user can override this per-connect by filling the "Proxy URL" field
 * in the connect panel (e.g. http://localhost:8787 when running the proxy
 * locally via `npm start --prefix proxy`). If they leave it empty, this
 * constant is used.
 *
 * Set to null to call Cloud directly (will fail until Redis disables the
 * managed challenge on API endpoints).
 *
 * Wire shape: <PROXY>/<upstream-host>/<...path>
 */
const DEFAULT_CLOUD_PROXY_URL = "https://redis-agent-memory-inspector.vercel.app";

const HEADERS = (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
});

export function createCloudClient(cfg) {
    const { url, apiKey, storeId } = cfg;
    if (!apiKey) throw new Error("cloud client: cfg.apiKey is required");
    if (!storeId) throw new Error("cloud client: cfg.storeId is required");

    // Build the base URL. If a proxy is configured (the common case while
    // Cloudflare's managed challenge is in the way), the request goes to
    // <PROXY>/<upstream-host>/v1/stores/<storeId> - the proxy strips its
    // own host and forwards to <upstream-host>/v1/stores/<storeId>/...
    // Otherwise we hit the upstream directly.
    //
    // cfg.proxyUrl wins over the built-in default - lets the user point at
    // a local proxy (http://localhost:8787) from the connect panel without
    // editing source.
    const cleanUrl = url.replace(/\/+$/, "");
    const upstreamHost = new URL(cleanUrl).host;
    const effectiveProxy = cfg.proxyUrl ?? DEFAULT_CLOUD_PROXY_URL;
    const root = effectiveProxy
        ? `${effectiveProxy.replace(/\/+$/, "")}/${upstreamHost}`
        : cleanUrl;
    const base = `${root}/v1/stores/${encodeURIComponent(storeId)}`;
    const headers = HEADERS(apiKey);

    // ----- generic request helper ----------------------------------------

    async function request(method, path, { query, body } = {}) {
        let urlStr = `${base}${path}`;
        if (query) {
            const qs = Object.entries(query)
                .filter(([, v]) => v !== undefined && v !== null && v !== "")
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join("&");
            if (qs) urlStr += `?${qs}`;
        }
        const res = await fetch(urlStr, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
            // Try to surface the structured error if Cloud returned one.
            let detail = res.statusText;
            try {
                const errBody = await res.json();
                detail = errBody.detail ?? errBody.title ?? JSON.stringify(errBody);
            } catch {
                // body wasn't JSON
            }
            throw new Error(`${method} ${path} → ${res.status} (${detail})`);
        }
        // 204 = no content. Return null rather than crashing res.json().
        if (res.status === 204) return null;
        return res.json();
    }

    // ----- translation helpers -------------------------------------------

    /** Cloud LTM record → OSS-shaped memory record. */
    function toOssMemory(m) {
        return {
            id: m.id,
            text: m.text,
            memory_type: m.memoryType,
            user_id: m.ownerId ?? null,
            session_id: m.sessionId ?? null,
            namespace: NS,
            topics: m.topics ?? [],
            entities: m.entities ?? [],
            created_at: m.createdAt,
            updated_at: m.updatedAt,
        };
    }

    /** Cloud session event → OSS-shaped message. */
    function toOssMessage(e) {
        const text = e.content?.[0]?.text ?? "";
        return {
            id: e.eventId,
            role: (e.role ?? "user").toLowerCase(),
            content: text,
            created_at: e.createdAt,
            session_id: e.sessionId,
        };
    }

    /** Cloud session-memory response → OSS-shaped working memory. */
    function toOssWorkingMemory(cm) {
        return {
            session_id: cm.sessionId,
            user_id: cm.ownerId ?? null,
            namespace: NS,
            messages: (cm.events ?? []).map(toOssMessage),
            summary: cm.summary ?? null,
            memories: cm.memories ?? [],
        };
    }

    // ----- method implementations ----------------------------------------

    async function pingHealth() {
        // A lightweight authenticated call - listing sessions is cheap and
        // confirms auth+host+storeId in one shot. We accept any 2xx as live.
        try {
            const res = await fetch(`${base}/session-memory?limit=1`, {
                headers,
            });
            if (res.ok) return { ok: true };

            // Pull whatever body the server sent so the user can see *why*
            // it's failing. Could be cloud's structured JSON ({detail,title})
            // OR a plain-text response from a CDN/WAF in front of it.
            const raw = await res.text();
            console.warn(
                `[AMS cloud] pingHealth got ${res.status}; body:`,
                raw,
            );
            let detail = res.statusText;
            try {
                const body = JSON.parse(raw);
                detail = body.detail ?? body.title ?? body.message ?? detail;
            } catch {
                // not JSON - use the raw text, truncated
                detail = raw ? raw.slice(0, 200) : detail;
            }
            return { ok: false, status: res.status, detail };
        } catch (err) {
            console.warn("[AMS cloud] pingHealth threw:", err);
            return { ok: false, status: 0, detail: err.message };
        }
    }

    async function listSessions(userId /* , namespace */) {
        // Cloud session-memory listing doesn't filter by user_id at the
        // server - we return all sessions and let the caller filter if it
        // wants. (For most apps, userId is implicit in the store anyway.)
        const data = await request("GET", "/session-memory", {
            query: { limit: 50 },
        });
        // Defensive: not strictly needed, but quiet the unused-param lint.
        void userId;
        return data?.items ?? [];
    }

    async function getWorkingMemory(sessionId /* , userId, namespace */) {
        const cm = await request(
            "GET",
            `/session-memory/${encodeURIComponent(sessionId)}`,
        );
        return toOssWorkingMemory(cm ?? {});
    }

    async function searchLongTermMemory(userId, namespace, filter = {}) {
        // Map OSS-shape filter → cloud's nested { filter, filterOp } shape.
        const cloudFilter = {};
        if (userId) cloudFilter.ownerId = { eq: userId };
        if (filter.sessionId) cloudFilter.sessionId = { eq: filter.sessionId };
        if (filter.topics?.length) cloudFilter.topics = { any: filter.topics };
        if (filter.entities?.length)
            cloudFilter.entities = { any: filter.entities };

        // Cloud rejects requests with neither `text` nor `filter`. We use a
        // single-space `text` as a benign "match anything" sentinel when the
        // caller hasn't supplied either - cloud accepts it and returns
        // results.
        const body = {};
        const hasFilter = Object.keys(cloudFilter).length > 0;
        const hasText = filter.text && filter.text.trim().length > 0;
        if (hasText) body.text = filter.text;
        else if (!hasFilter) body.text = " ";
        if (hasFilter) {
            body.filter = cloudFilter;
            body.filterOp = "any";
        }
        // Namespace doesn't exist on cloud - silently ignore.
        void namespace;

        const data = await request("POST", "/long-term-memory/search", { body });
        const items = data?.items ?? [];
        return {
            memories: items.map(toOssMemory),
            total: items.length,
        };
    }

    /**
     * Scan one page of long-term memory and collect distinct ownerIds.
     * Namespaces don't exist on cloud - always returns []. Uses a
     * single-space text sentinel because cloud requires non-empty text or
     * a filter, and we want to fetch everything regardless of owner.
     */
    async function discoverFilters() {
        const data = await request("POST", "/long-term-memory/search", {
            body: { text: " " },
        });
        const items = data?.items ?? [];
        const users = [
            ...new Set(items.map((m) => m.ownerId).filter(Boolean)),
        ].sort();
        return { users, namespaces: [] };
    }

    async function deleteWorkingMemory(sessionId /* , userId, namespace */) {
        await request(
            "DELETE",
            `/session-memory/${encodeURIComponent(sessionId)}`,
        );
        return { status: "ok" };
    }

    async function deleteLongTermMemory(memoryIds) {
        const ids = Array.isArray(memoryIds) ? memoryIds : [memoryIds];
        const data = await request("DELETE", "/long-term-memory", {
            body: { memoryIds: ids },
        });
        return { status: "ok", deleted: data?.deleted ?? [] };
    }

    // Summary views are an OSS-server feature; the Cloud / Iris API surface
    // doesn't expose them today. Stubbed so the inspector can call these
    // uniformly without backend-specific branching - they just return
    // "nothing here" and the UI gracefully skips the banners.
    async function listSummaryViews() {
        return [];
    }
    async function createSummaryView() {
        throw new Error("summary views not supported on cloud backend");
    }
    async function listSummaryViewPartitions() {
        return [];
    }
    async function runSummaryViewPartition() {
        throw new Error("summary views not supported on cloud backend");
    }

    return {
        backend: "cloud",
        pingHealth,
        listSessions,
        getWorkingMemory,
        searchLongTermMemory,
        discoverFilters,
        deleteWorkingMemory,
        deleteLongTermMemory,
        listSummaryViews,
        createSummaryView,
        listSummaryViewPartitions,
        runSummaryViewPartition,
    };
}
