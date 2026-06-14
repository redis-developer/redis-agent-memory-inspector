/**
 * Agent Memory client interface - factory that returns a backend-specific client.
 *
 * Two Redis Agent Memory-compatible backends share this surface:
 *
 *   - Open-source `redis/agent-memory-server`     (backend: "oss")
 *   - Redis Cloud Agent Memory / Iris             (backend: "cloud")
 *
 * The cloud client translates its camelCase responses back to the OSS
 * snake_case shape, so the rest of the inspector (renderers, panels) is
 * indifferent to which backend it's reading from.
 *
 * Cfg shape:
 *
 *   { backend: "oss",   url, apiKey? }
 *   { backend: "cloud", url, apiKey,  storeId }
 *
 * Client shape - domain-namespaced. All methods async.
 *
 *   backend                       → "oss" | "cloud"
 *   supportsNamespaces            → boolean (cross-cutting; affects every domain)
 *   supportsUserIdServerFilter    → boolean (cross-cutting; affects sessions/LTM scoping)
 *
 *   health.ping()                                       → { ok, status? }
 *   sessions.list(userId, namespace)                    → string[]
 *   workingMemory.get(sessionId, userId, namespace)     → WorkingMemory
 *   workingMemory.delete(sessionId, userId, namespace)  → { status }
 *   longTermMemory.search(userId, namespace, filter)    → { memories, total }
 *   longTermMemory.delete(memoryIds)                    → { status }
 *   longTermMemory.supportsOptimizeQuery                → boolean
 *   discovery.filters()                                 → { users, namespaces }
 *
 *   summaryViews?                                       → optional domain (absent on Cloud)
 *     .list()                                           → SummaryView[]
 *     .create(spec)                                     → SummaryView
 *     .listPartitions(viewId, filters)                  → PartitionResult[]
 *     .runPartition(viewId, group)                      → PartitionResult
 *
 * Optional domains are absent (not stubbed) on backends that don't
 * support them - check via `if (client.summaryViews)`.
 *
 * Adding a method: extend the relevant domain in both backend impls and
 * this comment. Adding a whole new optional domain: add it to the
 * backend(s) that support it; absence is the supported-or-not signal.
 */

import { createOssClient } from "./agent-memory/oss.js";
import { createCloudClient } from "./agent-memory/cloud.js";

export function createAgentMemoryClient(config) {
    if (!config?.url) {
        throw new Error("createAgentMemoryClient: config.url is required");
    }
    const backend = config.backend ?? "oss";
    switch (backend) {
        case "oss":
            return createOssClient(config);
        case "cloud":
            return createCloudClient(config);
        default:
            throw new Error(`createAgentMemoryClient: unknown backend "${backend}"`);
    }
}
