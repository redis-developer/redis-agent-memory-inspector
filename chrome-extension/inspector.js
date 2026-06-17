/**
 * Inspector entry point - reads the active connection from
 * chrome.storage.session (written by config.js when the user clicks
 * Connect) and runs the poller against it. If storage is empty, bounces
 * back to config.html so the user can re-enter credentials.
 *
 * The inspector holds no persistent state across the page itself - all
 * config + saved-connections state lives in chrome.storage.session and
 * is read fresh on load. User + session can be re-picked at any time
 * from the header picker pills without reconnecting.
 */

import { $, fromTemplate } from "./lib/dom.js";
import { createAgentMemoryClient } from "./lib/agent-memory-client.js";
import { createPoller } from "./lib/polling.js";
import { timeStr } from "./lib/format.js";
import { ensureSummaryViews } from "./lib/summary-views.js";
import { getActive, clearActive } from "./lib/saved-connections.js";
import * as workingPanel from "./panels/working-memory-panel.js";
import * as longTermPanel from "./panels/long-term-memory-panel.js";

// Fallback poll cadences when the config doesn't supply explicit values
// (the connect form provides them by default, so this rarely fires).
const WORKING_MEMORY_REFRESH_MS = 3000;
const LONG_TERM_MEMORY_REFRESH_MS = 5000;

let config = null;
let poller = null;
let client = null; // backend-specific Redis Agent Memory client, created on connect
let summaryViewIds = null; // { userProfileViewId, sessionProfileViewId } | null

document.addEventListener("DOMContentLoaded", async () => {
    const active = await getActive();
    if (!active) {
        // Direct hit on inspector.html without going through config first -
        // bounce back to the connect page.
        window.location.href = "config.html";
        return;
    }

    // Long-term panel owns its filter state and per-card delete affordance.
    // We subscribe so a filter change triggers a refetch, and we provide a
    // delete handler that calls Redis Agent Memory then refetches.
    longTermPanel.init({
        onChange: pollLongTerm,
        onDelete: handleLongTermDelete,
    });

    $("reconfigure-button").addEventListener("click", async () => {
        poller?.stop();
        await clearActive();
        window.location.href = "config.html";
    });

    $("refresh-button").addEventListener("click", refreshNow);

    // Working-memory clear: session-level deletion. Confirms before firing
    // because the operation is destructive (no soft delete, no undo).
    $("working-clear-button").addEventListener("click", handleWorkingClear);

    // Summary-view refresh: forces Redis Agent Memory to re-run the LLM for
    // the active scope's partition. Disabled while in flight to prevent
    // concurrent runs; the spinning class on the icon signals progress.
    $("ltm-summary-refresh").addEventListener("click", handleSummaryRefresh);

    await connect(active);
});

async function connect(newConfig) {
    config = newConfig;
    client = createAgentMemoryClient(config);
    workingPanel.reset();
    longTermPanel.reset();
    longTermPanel.setCapabilities({
        optimizeQuery: client.longTermMemory.supportsOptimizeQuery,
    });

    // Pick the most recent namespace + user + session before the first poll
    // fires. If discovery finds nothing for any of them, leave that field
    // null - working/LTM fetches will degrade to broader scopes ("show all"
    // or "(none)" filter) until the user picks a value from the pill.
    await autoPickFilters();
    renderConnectionPills();
    longTermPanel.setContext({
        userId: config.userId,
        namespace: config.namespace,
        hasSession: !!config.sessionId,
    });

    // Fire-and-forget the SummaryView bootstrap. Failure leaves
    // summaryViewIds = null, which the LTM panel reads as "no banners for
    // this connection" - we don't block polling on it.
    summaryViewIds = await ensureSummaryViews(client);

    poller = createPoller({
        onWorking: pollWorking,
        onLongTerm: pollLongTerm,
        workingMs: config.workingMemoryRefreshMs ?? WORKING_MEMORY_REFRESH_MS,
        longTermMs: config.longTermMemoryRefreshMs ?? LONG_TERM_MEMORY_REFRESH_MS,
    });
    poller.start();
}

/**
 * Run discovery on the now-live client to seed config.namespace +
 * config.userId + config.sessionId with the most recently active values.
 * discoverFilters() preserves LTM-scan order, so users[0] / namespaces[0]
 * = most recent. listSessions() returns ordered sessions; we take the first.
 */
async function autoPickFilters() {
    try {
        const { users, namespaces } = await client.discovery.filters();
        if (namespaces.length > 0) config.namespace = namespaces[0];
        if (users.length > 0) config.userId = users[0];
    } catch (err) {
        setStatus(`couldn't discover filters: ${err.message}`);
    }
    try {
        const sessions = await client.sessions.list(config.userId, config.namespace);
        if (sessions.length > 0) config.sessionId = sessions[0];
    } catch (err) {
        setStatus(`couldn't list sessions: ${err.message}`);
    }
}

function renderConnectionPills() {
    const pills = $("connection-pills");
    pills.innerHTML = "";
    pills.appendChild(staticPill("url", new URL(config.url).host));

    // Namespace pill - only on backends that support namespaces.
    if (client.supportsNamespaces) {
        pills.appendChild(
            pickerPill({
                key: "ns",
                value: config.namespace,
                allowNone: true,
                getOptions: async () => {
                    const { namespaces } = await client.discovery.filters();
                    return namespaces;
                },
                onPick: (value) => applyFilterChange({ namespace: value }),
            }),
        );
    }

    pills.appendChild(
        pickerPill({
            key: "user",
            value: config.userId,
            allowNone: true,
            getOptions: async () => {
                const { users } = await client.discovery.filters();
                return users;
            },
            onPick: (value) => applyFilterChange({ userId: value }),
        }),
    );
    pills.appendChild(
        pickerPill({
            key: "session",
            value: config.sessionId,
            allowNone: true,
            getOptions: () => client.sessions.list(config.userId, config.namespace),
            onPick: (value) => applyFilterChange({ sessionId: value }),
        }),
    );
}

/**
 * Apply a single filter pill change. The pills are linked: changing
 * namespace or user invalidates the current session (because session
 * listing depends on both), so we re-list sessions and auto-pick the most
 * recent. Changing only the session leaves namespace/user alone.
 *
 * After mutating config we re-render the pills (so the displayed values stay
 * in sync), push the new context into the LTM panel (so the "this session"
 * tab + subtitle reflect what's actually scoped), reset the panes, and
 * trigger a fresh poll.
 */
async function applyFilterChange({ namespace, userId, sessionId }) {
    const changedScopeKey =
        namespace !== undefined || userId !== undefined;

    if (namespace !== undefined) config.namespace = namespace;
    if (userId !== undefined) config.userId = userId;

    if (changedScopeKey) {
        try {
            const sessions = await client.sessions.list(
                config.userId,
                config.namespace,
            );
            config.sessionId = sessions[0] ?? null;
        } catch {
            config.sessionId = null;
        }
    } else if (sessionId !== undefined) {
        config.sessionId = sessionId;
    }

    renderConnectionPills();
    longTermPanel.setContext({
        userId: config.userId,
        namespace: config.namespace,
        hasSession: !!config.sessionId,
    });
    workingPanel.reset();
    longTermPanel.reset();
    await refreshNow();
}

/** Read-only pill (url, namespace). Cloned from #static-pill-template. */
function staticPill(key, value) {
    const element = fromTemplate("static-pill-template");
    element.querySelector(".pill-key").textContent = key;
    element.querySelector(".pill-value").textContent = value;
    return element;
}

/**
 * Label shown in the picker dropdown when `allowNone` is true and the
 * user wants to clear the filter. Selecting it (or emptying the input)
 * commits a null pick.
 */
const NO_FILTER_LABEL = "(none)";

/**
 * Pill-styled native <select> for picking from a discovered list (users,
 * sessions, namespaces). Structure is defined in #picker-pill-template;
 * this function clones it, fetches the current option list, and wires
 * `change` to call onPick. Native <select> gives us keyboard nav,
 * screen-reader support, type-ahead, and click-outside handling for free.
 *
 * If `allowNone` is true, the dropdown surfaces a "(none)" entry mapped
 * to `onPick(null)` - useful for Redis Agent Memory filters that can be
 * unset to broaden the scope (user_id, namespace, session_id).
 *
 * Options are fetched once when the pill mounts. Pills are re-mounted on
 * every connect/filter change in `renderConnectionPills()`, so the list
 * stays fresh without separate cache invalidation.
 */
function pickerPill({ key, value, getOptions, onPick, allowNone = false }) {
    const wrapper = fromTemplate("picker-pill-template");
    wrapper.querySelector(".pill-key").textContent = key;
    const select = wrapper.querySelector(".pill-select");

    // Show the current value immediately so the pill renders something
    // while options load. The placeholder option is replaced once the
    // real list arrives.
    const placeholder = document.createElement("option");
    placeholder.value = value ?? "";
    placeholder.textContent = value ?? NO_FILTER_LABEL;
    placeholder.selected = true;
    select.appendChild(placeholder);

    select.addEventListener("change", () => {
        const pick = allowNone && select.value === "" ? null : select.value;
        if (pick === value) return;
        onPick(pick);
    });

    // Populate the real options. Done async so an `await getOptions()`
    // that talks to Redis Agent Memory doesn't block the rest of the pill
    // row from rendering.
    (async () => {
        try {
            const options = await getOptions();
            select.innerHTML = "";
            if (allowNone) {
                select.appendChild(makeOption("", NO_FILTER_LABEL, value === null));
            }
            for (const v of options) {
                select.appendChild(makeOption(v, v, v === value));
            }
        } catch (err) {
            setStatus(`couldn't load ${key} options: ${err.message}`);
        }
    })();

    return wrapper;
}

function makeOption(value, label, selected) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (selected) opt.selected = true;
    return opt;
}

async function pollWorking() {
    if (!client || !config?.sessionId) return;
    try {
        const workingMemory = await client.workingMemory.get(
            config.sessionId,
            config.userId,
            config.namespace,
        );
        workingPanel.render(workingMemory);
        setStatus(`working memory updated ${timeStr()}`);
    } catch (err) {
        setStatus(`working memory: ${err.message}`);
    }
}

async function pollLongTerm() {
    if (!client) return;
    try {
        // "This session" tab folds session_id into the filter so Redis
        // Agent Memory scopes the search to memories extracted from the
        // connected session. "Across sessions" leaves it out, preserving
        // the existing user-wide view.
        const scope = longTermPanel.getScope();
        const baseFilter = longTermPanel.getFilter();
        const filter =
            scope === "session" && config.sessionId
                ? { ...baseFilter, sessionId: config.sessionId }
                : baseFilter;
        const data = await client.longTermMemory.search(
            config.userId,
            config.namespace,
            filter,
        );
        longTermPanel.render(data.memories ?? []);
        setStatus(`long-term memory updated ${timeStr()}`);
    } catch (err) {
        setStatus(`long-term memory: ${err.message}`);
    }
    // Refresh the summary-view banner on the same cadence. Independent
    // try/catch so a summary-views 404 (Cloud, or AMS too old) doesn't
    // mask the LTM update above.
    refreshSummaryBanner().catch((err) =>
        console.warn("[inspector] summary banner refresh failed:", err.message),
    );
}

async function handleSummaryRefresh() {
    if (!client || !summaryViewIds) return;
    const button = $("ltm-summary-refresh");
    if (button.disabled) return; // already in flight - prevent concurrent runs
    const scope = longTermPanel.getScope();
    const viewId =
        scope === "session"
            ? summaryViewIds.sessionProfileViewId
            : summaryViewIds.userProfileViewId;
    // The group object must contain exactly the keys the view was created
    // with - Redis Agent Memory rejects extras with HTTP 400 ("group keys
    // ... must exactly match view.group_by"). session view is grouped by
    // session_id only; user view by user_id only.
    const group =
        scope === "session"
            ? { session_id: config.sessionId }
            : { user_id: config.userId };
    button.disabled = true;
    button.classList.add("is-spinning");
    setStatus("recomputing summary…");
    try {
        const partition = await client.summaryViews.runPartition(viewId, group);
        longTermPanel.setSummary(partition);
        setStatus(`summary recomputed ${timeStr()}`);
    } catch (err) {
        setStatus(`summary refresh failed: ${err.message}`);
    } finally {
        button.disabled = false;
        button.classList.remove("is-spinning");
    }
}

async function refreshSummaryBanner() {
    // No summary-view support (Cloud, bootstrap failed) → hide the banner
    // entirely. Pass `null` to signal "not available."
    if (!client || !summaryViewIds) {
        longTermPanel.setSummary(null);
        return;
    }
    const scope = longTermPanel.getScope();
    const viewId =
        scope === "session"
            ? summaryViewIds.sessionProfileViewId
            : summaryViewIds.userProfileViewId;
    // Filter keys have to match the view's group_by exactly - passing
    // extra keys (e.g. user_id on a session-grouped view) returns zero
    // partitions instead of the relevant one.
    const filters =
        scope === "session"
            ? { session_id: config.sessionId }
            : { user_id: config.userId };
    const partitions = await client.summaryViews.listPartitions(viewId, filters);
    // Empty array → pass `{}` so the banner shows the empty-state copy
    // and keeps the ↻ refresh button reachable. Populated → pass the
    // partition itself.
    longTermPanel.setSummary(partitions?.[0] ?? {});
}

async function refreshNow() {
    if (!config) return;
    const button = $("refresh-button");
    button.classList.add("is-spinning");
    setTimeout(() => button.classList.remove("is-spinning"), 400);
    await poller?.runNow();
}

async function handleWorkingClear() {
    if (!client) return;
    const ok = confirm(
        `Clear working memory for session "${config.sessionId}"?\n\nAll messages and the running summary will be deleted. This cannot be undone.`,
    );
    if (!ok) return;
    try {
        await client.workingMemory.delete(
            config.sessionId,
            config.userId,
            config.namespace,
        );
        setStatus(`working memory cleared for ${config.sessionId}`);
        workingPanel.reset(); // forget seen-ids so next render flashes fresh content
        await pollWorking();
    } catch (err) {
        setStatus(`clear failed: ${err.message}`);
    }
}

async function handleLongTermDelete(memoryId) {
    if (!client) return;
    try {
        await client.longTermMemory.delete([memoryId]);
        setStatus(`deleted memory ${memoryId.slice(0, 12)}…`);
        await pollLongTerm();
    } catch (err) {
        setStatus(`delete failed: ${err.message}`);
    }
}

function setStatus(s) {
    $("status-line").textContent = s;
}
