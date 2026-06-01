/**
 * OSS AMS client - talks to `redis/agent-memory-server`.
 *
 * Endpoint shape:
 *
 *   GET    /v1/health
 *   GET    /v1/working-memory/{sessionId}
 *   DELETE /v1/working-memory/{sessionId}
 *   GET    /v1/working-memory/         (list sessions)
 *   POST   /v1/long-term-memory/       (bulk create)
 *   POST   /v1/long-term-memory/search
 *   DELETE /v1/long-term-memory?memory_ids=...
 *
 * Auth: optional. We don't send a Bearer token by default; if the server
 * has auth enabled the caller can pass `apiKey` in cfg and we'll attach it.
 *
 * Field naming: snake_case (`user_id`, `session_id`, `memory_type`,
 * `created_at`). The rest of the inspector code is written against this
 * shape, so the cloud client translates camelCase responses back into it.
 */

const PATHS = {
    health: "/v1/health",
    workingMemory: (sid) => `/v1/working-memory/${encodeURIComponent(sid)}`,
    listSessions: "/v1/working-memory/",
    ltmSearch: "/v1/long-term-memory/search",
    ltmRoot: "/v1/long-term-memory",
};

export function createOssClient(cfg) {
    const { url } = cfg;
    const authHeaders = cfg.apiKey
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : {};

    async function pingHealth() {
        try {
            const res = await fetch(`${url}${PATHS.health}`, {
                headers: authHeaders,
            });
            if (res.ok) return { ok: true };
            let detail = res.statusText;
            try {
                const body = await res.json();
                detail = body.detail ?? body.title ?? detail;
            } catch {
                // body wasn't JSON
            }
            return { ok: false, status: res.status, detail };
        } catch (err) {
            return { ok: false, status: 0, detail: err.message };
        }
    }

    async function listSessions(userId, namespace) {
        const params = new URLSearchParams({ limit: "50" });
        if (userId) params.set("user_id", userId);
        if (namespace) params.set("namespace", namespace);
        const res = await fetch(`${url}${PATHS.listSessions}?${params}`, {
            headers: authHeaders,
        });
        if (!res.ok) throw new Error(`list sessions failed (${res.status})`);
        const data = await res.json();
        return data.sessions ?? [];
    }

    async function getWorkingMemory(sessionId, userId, namespace) {
        const params = new URLSearchParams();
        if (userId) params.set("user_id", userId);
        if (namespace) params.set("namespace", namespace);
        const res = await fetch(
            `${url}${PATHS.workingMemory(sessionId)}?${params}`,
            { headers: authHeaders },
        );
        if (!res.ok) throw new Error(`working memory ${res.status}`);
        return res.json();
    }

    async function searchLongTermMemory(userId, namespace, filter = {}) {
        const body = { text: filter.text ?? "", limit: 50 };
        if (userId) body.user_id = { eq: userId };
        if (namespace) body.namespace = { eq: namespace };
        if (filter.topics?.length) body.topics = { any: filter.topics };
        if (filter.entities?.length) body.entities = { any: filter.entities };

        const qs = filter.optimizeQuery ? "?optimize_query=true" : "";
        const res = await fetch(`${url}${PATHS.ltmSearch}${qs}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`ltm search ${res.status}`);
        return res.json();
    }

    /**
     * Derive distinct user_ids + namespaces by scanning long-term memory.
     * AMS doesn't expose first-class enumeration endpoints; this is the
     * intentional workaround. Capped at one page (limit=100), so brand-new
     * users without memories yet won't appear - those callers can type the
     * value manually.
     */
    async function discoverFilters() {
        const res = await fetch(`${url}${PATHS.ltmSearch}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ text: "", limit: 100 }),
        });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const data = await res.json();
        const users = [
            ...new Set(data.memories.map((m) => m.user_id).filter(Boolean)),
        ].sort();
        const namespaces = [
            ...new Set(data.memories.map((m) => m.namespace).filter(Boolean)),
        ].sort();
        return { users, namespaces };
    }

    async function deleteWorkingMemory(sessionId, userId, namespace) {
        const params = new URLSearchParams();
        if (userId) params.set("user_id", userId);
        if (namespace) params.set("namespace", namespace);
        const res = await fetch(
            `${url}${PATHS.workingMemory(sessionId)}?${params}`,
            { method: "DELETE", headers: authHeaders },
        );
        if (!res.ok) throw new Error(`delete working memory ${res.status}`);
        return res.json();
    }

    async function deleteLongTermMemory(memoryIds) {
        const ids = Array.isArray(memoryIds) ? memoryIds : [memoryIds];
        const qs = ids
            .map((id) => `memory_ids=${encodeURIComponent(id)}`)
            .join("&");
        const res = await fetch(`${url}${PATHS.ltmRoot}?${qs}`, {
            method: "DELETE",
            headers: authHeaders,
        });
        if (!res.ok) throw new Error(`delete ltm ${res.status}`);
        return res.json();
    }

    return {
        backend: "oss",
        pingHealth,
        listSessions,
        getWorkingMemory,
        searchLongTermMemory,
        discoverFilters,
        deleteWorkingMemory,
        deleteLongTermMemory,
    };
}
