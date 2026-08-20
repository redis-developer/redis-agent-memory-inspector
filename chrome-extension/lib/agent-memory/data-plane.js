/**
 * Shared Data Plane client, used by both the Cloud and the self-managed
 * backends. They speak the identical `/v1/stores/{storeId}/...` Data Plane
 * API; only the base URL, auth headers, and health probe differ, so those
 * are injected by each backend and everything else lives here.
 *
 * Records are returned as the Data Plane sends them (camelCase). The one
 * reshape is working memory: its ordered `events` (UPPER-case roles, content
 * arrays) are flattened into a simple message list for the pane.
 */

export function createDataPlaneClient({
    backend,
    base,
    headers,
    ping,
    supportsNamespaces = false,
}) {
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
            let detail = res.statusText;
            try {
                const errBody = await res.json();
                detail = errBody.detail ?? errBody.title ?? JSON.stringify(errBody);
            } catch {
                // body wasn't JSON
            }
            throw new Error(`${method} ${path} → ${res.status} (${detail})`);
        }
        if (res.status === 204) return null;
        return res.json();
    }

    // ----- working-memory shaping ----------------------------------------

    function toMessage(e) {
        return {
            id: e.eventId,
            role: (e.role ?? "user").toLowerCase(),
            content: e.content?.[0]?.text ?? "",
            createdAt: e.createdAt,
        };
    }

    function toWorkingMemory(cm) {
        return {
            sessionId: cm.sessionId,
            ownerId: cm.ownerId ?? null,
            namespace: cm.namespace ?? null,
            messages: (cm.events ?? []).map(toMessage),
            summary: cm.summary ?? null,
        };
    }

    // ----- method implementations ----------------------------------------

    async function listSessions(userId) {
        // The Data Plane requires exactly one of filterOwnerId / includeAll
        // (mutually exclusive): scope to the owner when a user is picked,
        // otherwise list every session in the store.
        const data = await request("GET", "/session-memory", {
            query: userId ? { filterOwnerId: userId } : { includeAll: true },
        });
        return data?.items ?? [];
    }

    async function getWorkingMemory(sessionId) {
        const cm = await request(
            "GET",
            `/session-memory/${encodeURIComponent(sessionId)}`,
        );
        return toWorkingMemory(cm ?? {});
    }

    async function searchLongTermMemory(userId, namespace, filter = {}) {
        const dataPlaneFilter = {};
        if (userId) dataPlaneFilter.ownerId = { eq: userId };
        if (namespace) dataPlaneFilter.namespace = { eq: namespace };
        const sessionIds = filter.sessionIds ?? [];
        if (sessionIds.length === 1)
            dataPlaneFilter.sessionId = { eq: sessionIds[0] };
        else if (sessionIds.length > 1)
            dataPlaneFilter.sessionId = { in: sessionIds };
        const memoryTypes = filter.memoryTypes ?? [];
        if (memoryTypes.length === 1)
            dataPlaneFilter.memoryType = { eq: memoryTypes[0] };
        else if (memoryTypes.length > 1)
            dataPlaneFilter.memoryType = { in: memoryTypes };
        if (filter.topics?.length) dataPlaneFilter.topics = { in: filter.topics };

        // The endpoint rejects requests with neither `text` nor `filter`; a
        // single-space text is a benign match-all sentinel.
        const body = {};
        const hasFilter = Object.keys(dataPlaneFilter).length > 0;
        const hasText = filter.text && filter.text.trim().length > 0;
        if (hasText) body.text = filter.text;
        else if (!hasFilter) body.text = " ";
        if (hasFilter) {
            body.filter = dataPlaneFilter;
            body.filterOp = "all";
        }

        const data = await request("POST", "/long-term-memory/search", { body });
        const items = data?.items ?? [];
        return { memories: items, total: items.length };
    }

    async function discoverFilters() {
        const data = await request("POST", "/long-term-memory/search", {
            body: { text: " " },
        });
        const items = data?.items ?? [];
        // Preserve scan order so the first owner is the most recently active -
        // auto-pick in inspector.js relies on this.
        const users = [...new Set(items.map((m) => m.ownerId).filter(Boolean))];
        const namespaces = [
            ...new Set(items.map((m) => m.namespace).filter(Boolean)),
        ];
        return { users, namespaces };
    }

    async function deleteWorkingMemory(sessionId) {
        await request(
            "DELETE",
            `/session-memory/${encodeURIComponent(sessionId)}`,
        );
        return { status: "ok" };
    }

    /**
     * Append one event to a session's working memory. Creates the session
     * if it doesn't exist. Roles are limited to USER/ASSISTANT/SYSTEM by the
     * Data Plane.
     */
    async function appendSessionEvent(
        sessionId,
        { role, content, actorId, namespace } = {},
    ) {
        const body = {
            sessionId,
            actorId: actorId || "redis-agent-memory-inspector",
            role: (role ?? "user").toUpperCase(),
            content: [{ text: content }],
            createdAt: new Date().toISOString(),
        };
        if (namespace) body.namespace = namespace;
        return request("POST", "/session-memory/events", { body });
    }

    async function getLongTermMemory(memoryId) {
        return request(
            "GET",
            `/long-term-memory/${encodeURIComponent(memoryId)}`,
        );
    }

    async function deleteLongTermMemory(memoryIds) {
        const ids = Array.isArray(memoryIds) ? memoryIds : [memoryIds];
        const data = await request("DELETE", "/long-term-memory", {
            body: { memoryIds: ids },
        });
        return { status: "ok", deleted: data?.deleted ?? [] };
    }

    return {
        backend,
        supportsNamespaces,
        health: Object.freeze({ ping }),
        sessions: Object.freeze({ list: listSessions }),
        workingMemory: Object.freeze({
            get: getWorkingMemory,
            delete: deleteWorkingMemory,
            append: appendSessionEvent,
        }),
        longTermMemory: Object.freeze({
            get: getLongTermMemory,
            search: searchLongTermMemory,
            delete: deleteLongTermMemory,
        }),
        discovery: Object.freeze({ filters: discoverFilters }),
    };
}
