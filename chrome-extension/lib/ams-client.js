/**
 * AMS client interface - factory that returns a backend-specific client.
 *
 * Two AMS-compatible backends share this surface:
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
 * Client interface (all methods async):
 *
 *   pingHealth()                                       → { ok, status? }
 *   listSessions(userId, namespace)                    → string[]
 *   getWorkingMemory(sessionId, userId, namespace)     → WorkingMemory
 *   searchLongTermMemory(userId, namespace, filter)    → { memories, total }
 *   discoverFilters()                                  → { users, namespaces }
 *   deleteWorkingMemory(sessionId, userId, namespace)  → { status }
 *   deleteLongTermMemory(memoryIds)                    → { status }
 *   listSummaryViews()                                 → SummaryView[]
 *   createSummaryView(spec)                            → SummaryView
 *   listSummaryViewPartitions(viewId, filters)         → PartitionResult[]
 *
 * Cloud doesn't expose summary views; its impls return [] / throw so the
 * caller can degrade without backend-specific branches.
 *
 * The interface is deliberately small - it covers exactly what the
 * inspector uses today. Adding a method (e.g. `memoryPrompt`) means
 * adding it to both backend impls and updating this comment.
 */

import { createOssClient } from "./ams/oss.js";
import { createCloudClient } from "./ams/cloud.js";

export function createAmsClient(cfg) {
    if (!cfg?.url) {
        throw new Error("createAmsClient: cfg.url is required");
    }
    const backend = cfg.backend ?? "oss";
    switch (backend) {
        case "oss":
            return createOssClient(cfg);
        case "cloud":
            return createCloudClient(cfg);
        default:
            throw new Error(`createAmsClient: unknown backend "${backend}"`);
    }
}
