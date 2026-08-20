/**
 * Agent Memory client interface - factory that returns a backend-specific client.
 *
 * Two Redis Agent Memory backends share this surface, both speaking the same
 * store-scoped `/v1/stores/{storeId}/...` Data Plane API:
 *
 *   - Redis Cloud Agent Memory / Iris   (backend: "cloud")
 *   - Self-managed Iris Data Plane      (backend: "self-managed")
 *
 * Records are returned as the Data Plane sends them (camelCase); only working
 * memory is reshaped (its event stream flattened into a message list), so the
 * renderers/panels are indifferent to which backend they're reading from.
 *
 * Cfg shape:
 *
 *   { backend: "cloud",        url, apiKey, storeId, proxyUrl? }
 *   { backend: "self-managed", url, storeId, auth: { method, credential? } }
 *
 * Client shape - domain-namespaced. All methods async.
 *
 *   backend                       → "cloud" | "self-managed"
 *   supportsNamespaces            → boolean (cross-cutting; affects every domain)
 *
 *   health.ping()                                       → { ok, status? }
 *   sessions.list(userId)                               → string[]
 *   workingMemory.get(sessionId)                        → WorkingMemory
 *   workingMemory.delete(sessionId)                     → { status }
 *   longTermMemory.get(memoryId)                        → memory record
 *   longTermMemory.search(userId, namespace, filter)    → { memories, total }
 *   longTermMemory.delete(memoryIds)                    → { status }
 *   discovery.filters()                                 → { users, namespaces }
 */

import { createCloudClient } from "./agent-memory/cloud.js";
import { createSelfManagedClient } from "./agent-memory/self-managed.js";

export function createAgentMemoryClient(config) {
    if (!config?.url) {
        throw new Error("createAgentMemoryClient: config.url is required");
    }
    const backend = config.backend ?? "cloud";
    switch (backend) {
        case "cloud":
            return createCloudClient(config);
        case "self-managed":
            return createSelfManagedClient(config);
        default:
            throw new Error(`createAgentMemoryClient: unknown backend "${backend}"`);
    }
}
