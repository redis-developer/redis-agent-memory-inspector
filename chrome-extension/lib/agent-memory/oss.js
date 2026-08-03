/**
 * OSS Redis Agent Memory client - talks to `redis/agent-memory-server`.
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
 * has auth enabled the caller can pass `apiKey` in config and we'll attach it.
 *
 * Field naming: snake_case (`user_id`, `session_id`, `memory_type`,
 * `created_at`). The rest of the inspector code is written against this
 * shape, so the cloud client translates camelCase responses back into it.
 */

const PATHS = {
    health: "/v1/health",
    workingMemory: (sessionId) => `/v1/working-memory/${encodeURIComponent(sessionId)}`,
    listSessions: "/v1/working-memory/",
    ltmSearch: "/v1/long-term-memory/search",
    ltmRoot: "/v1/long-term-memory",
    summaryViews: "/v1/summary-views",
    summaryView: (viewId) => `/v1/summary-views/${encodeURIComponent(viewId)}`,
    summaryViewRun: (viewId) =>
        `/v1/summary-views/${encodeURIComponent(viewId)}/run`,
    summaryViewPartitions: (viewId) =>
        `/v1/summary-views/${encodeURIComponent(viewId)}/partitions`,
    summaryViewPartitionRun: (viewId) =>
        `/v1/summary-views/${encodeURIComponent(viewId)}/partitions/run`,
};

export function createOssClient(config) {
    const { url } = config;
    const authHeaders = config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
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
        // Session scoping: single id → eq, several → any (multi-select).
        const sessionIds = filter.sessionIds ?? [];
        if (sessionIds.length === 1) body.session_id = { eq: sessionIds[0] };
        else if (sessionIds.length > 1) body.session_id = { any: sessionIds };
        if (filter.topics?.length) body.topics = { any: filter.topics };
        if (filter.entities?.length) body.entities = { any: filter.entities };
        const memoryTypes = filter.memoryTypes ?? [];
        if (memoryTypes.length === 1) body.memory_type = { eq: memoryTypes[0] };
        else if (memoryTypes.length > 1) body.memory_type = { any: memoryTypes };

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
        // Preserve LTM-scan order so the first user/namespace in the list is
        // the most recently active. The auto-pick in inspector.js relies on this.
        const users = [
            ...new Set(data.memories.map((m) => m.user_id).filter(Boolean)),
        ];
        const namespaces = [
            ...new Set(data.memories.map((m) => m.namespace).filter(Boolean)),
        ];
        return { users, namespaces };
    }

    /**
     * Replace a session's working memory. Redis Agent Memory's PUT is a
     * full-record write (no append endpoint), so callers append by
     * GET → mutate → PUT. A PUT to an unknown session id creates it.
     */
    async function putWorkingMemory(sessionId, workingMemory) {
        const res = await fetch(`${url}${PATHS.workingMemory(sessionId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify(workingMemory),
        });
        if (!res.ok) {
            let detail = res.statusText;
            try {
                const body = await res.json();
                detail = JSON.stringify(body.detail ?? body);
            } catch {
                // body wasn't JSON
            }
            throw new Error(`put working memory ${res.status} (${detail})`);
        }
        return res.json();
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

    async function listSummaryViews() {
        const res = await fetch(`${url}${PATHS.summaryViews}`, {
            headers: authHeaders,
        });
        if (!res.ok) throw new Error(`list summary views ${res.status}`);
        return res.json();
    }

    async function createSummaryView(spec) {
        const res = await fetch(`${url}${PATHS.summaryViews}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify(spec),
        });
        if (!res.ok) {
            let detail = res.statusText;
            try {
                const body = await res.json();
                detail = body.detail ?? JSON.stringify(body);
            } catch {
                // body wasn't JSON
            }
            throw new Error(`create summary view ${res.status} (${detail})`);
        }
        return res.json();
    }

    // The server keeps already-computed partition summaries in storage;
    // deleting a view only removes its config, so its results stop being
    // computed and listed.
    async function deleteSummaryView(viewId) {
        const res = await fetch(`${url}${PATHS.summaryView(viewId)}`, {
            method: "DELETE",
            headers: authHeaders,
        });
        if (!res.ok) throw new Error(`delete summary view ${res.status}`);
    }

    // Recompute ALL partitions of a view. The server runs it as an async
    // background task - results land via later partition listings. The
    // endpoint requires a JSON body (RunSummaryViewRequest); an empty
    // object is valid and omitting it 422s.
    async function runSummaryView(viewId) {
        const res = await fetch(`${url}${PATHS.summaryViewRun(viewId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`run summary view ${res.status}`);
    }

    // Force a fresh recompute for one partition. Redis Agent Memory runs the summarization
    // LLM synchronously and returns the new SummaryViewPartitionResult. The
    // continuous worker's schedule is unaffected - it'll just see a fresher
    // cache the next time it ticks.
    async function runSummaryViewPartition(viewId, group) {
        const res = await fetch(
            `${url}${PATHS.summaryViewPartitionRun(viewId)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify({ group }),
            },
        );
        if (!res.ok) throw new Error(`run partition ${res.status}`);
        return res.json();
    }

    // Filters (user_id / session_id / namespace / memory_type) are query
    // params on the endpoint - Redis Agent Memory scopes the returned partitions to records
    // that match, so we don't have to filter client-side.
    async function listSummaryViewPartitions(viewId, filters = {}) {
        const params = new URLSearchParams();
        if (filters.user_id) params.set("user_id", filters.user_id);
        if (filters.session_id) params.set("session_id", filters.session_id);
        if (filters.namespace) params.set("namespace", filters.namespace);
        if (filters.memory_type) params.set("memory_type", filters.memory_type);
        const qs = params.toString();
        const path =
            PATHS.summaryViewPartitions(viewId) + (qs ? `?${qs}` : "");
        const res = await fetch(`${url}${path}`, { headers: authHeaders });
        if (!res.ok) throw new Error(`list partitions ${res.status}`);
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

        // Cross-cutting capability flags
        supportsNamespaces: true,
        supportsUserIdServerFilter: true,

        // Required domains
        health: Object.freeze({ ping: pingHealth }),
        sessions: Object.freeze({ list: listSessions }),
        workingMemory: Object.freeze({
            get: getWorkingMemory,
            put: putWorkingMemory,
            delete: deleteWorkingMemory,
        }),
        longTermMemory: Object.freeze({
            search: searchLongTermMemory,
            delete: deleteLongTermMemory,
            supportsOptimizeQuery: true,
        }),
        discovery: Object.freeze({ filters: discoverFilters }),

        // Optional domain (absent on backends that don't support it)
        summaryViews: Object.freeze({
            list: listSummaryViews,
            create: createSummaryView,
            delete: deleteSummaryView,
            run: runSummaryView,
            listPartitions: listSummaryViewPartitions,
            runPartition: runSummaryViewPartition,
        }),
    };
}
