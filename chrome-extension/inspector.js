/**
 * Inspector entry point - reads the active connection from
 * chrome.storage.session (written by config.js on Connect) and renders the
 * workspace against it. If storage is empty, bounces back to config.html.
 *
 *   Overview          - working memory + latest long-term extractions for
 *                       the selected user/namespace/session.
 *   Long-term memory  - full explorer: search, filters, records, summary views.
 *
 * No persistent page state - config + saved-connections live in
 * chrome.storage.session, read fresh on load. Data refreshes on user
 * action or opt-in per-pane auto-refresh; there is no background polling.
 */

import { $, fromTemplate } from "./lib/dom.js";
import { createAgentMemoryClient } from "./lib/agent-memory-client.js";
import { createAutoRefresh } from "./lib/auto-refresh.js";
import { timeStr } from "./lib/format.js";
import { listSummaryViews, createDefaultViews } from "./lib/summary-views.js";
import { getActive, clearActive } from "./lib/saved-connections.js";
import * as workingPanel from "./panels/working-memory-panel.js";
import * as longTermPanel from "./panels/long-term-memory-panel.js";
import * as summaryPanel from "./panels/summary-views-panel.js";

// A view's async run is polled at most this many times before we stop
// waiting for its partitions to appear.
const RUN_VIEW_POLL_ATTEMPTS = 10;
const RUN_VIEW_POLL_DELAY_MS = 3000;
// After an added event, extraction runs server-side; refetch at these
// offsets so the extracted flag + new records surface without polling.
const EXTRACTION_FOLLOW_UP_DELAYS_MS = [3000, 8000, 15000];

let config = null;
let client = null; // backend-specific Redis Agent Memory client, created on connect
let summaryViews = null; // SummaryView[] | null (null = backend has no support)
let knownSessions = []; // sessions for the current user/ns scope
let lastDiscovery = { users: [], namespaces: [] };

// Per-pane auto-refresh controls, created once and reused across connects.
const refreshers = {};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        onChange: pollRecords,
        onDelete: handleLongTermDelete,
        onScopeChange: applyFilterChange,
    });

    summaryPanel.init({
        onCreateDefaults: handleCreateDefaultViews,
        onRunView: handleRunSummaryView,
        onDeleteView: handleDeleteSummaryView,
        onRunPartition: handleSummaryRecompute,
    });

    initRefreshers();
    initViewTabs();
    initAddEventDialog();

    $("reconfigure-button").addEventListener("click", async () => {
        await clearActive();
        window.location.href = "config.html";
    });

    // Working-memory clear: session-level deletion. Confirms before firing
    // because the operation is destructive (no soft delete, no undo).
    $("working-clear-button").addEventListener("click", handleWorkingClear);

    await connect(active);
});

/**
 * One auto-refresh control per pane. Each drives only its own fetch; all
 * default OFF, so nothing polls until the user opts in. Enablement + rate
 * persist per pane key.
 */
function initRefreshers() {
    refreshers.working = createAutoRefresh({
        key: "working",
        refreshLabel: "Refresh working memory",
        onRefresh: pollWorking,
    });
    refreshers.overview = createAutoRefresh({
        key: "overview",
        refreshLabel: "Refresh long-term memory",
        onRefresh: pollOverview,
    });
    refreshers.records = createAutoRefresh({
        key: "records",
        refreshLabel: "Refresh records",
        onRefresh: pollRecords,
    });
    refreshers.summary = createAutoRefresh({
        key: "summary",
        refreshLabel: "Refresh summary views",
        onRefresh: pollSummaries,
    });
    $("working-refresh-slot").appendChild(refreshers.working.element);
    $("overview-refresh-slot").appendChild(refreshers.overview.element);
    $("records-refresh-slot").appendChild(refreshers.records.element);
    $("summary-refresh-slot").appendChild(refreshers.summary.element);
}

/** Fetch everything once - used on connect and after scope changes. */
async function refreshAll() {
    await Promise.all([pollWorking(), pollOverview(), pollRecords()]);
    await pollSummaries();
}

// ---------- view tabs (Overview | Long-term memory) ----------

function initViewTabs() {
    for (const tab of document.querySelectorAll(".view-tab")) {
        tab.addEventListener("click", () => switchView(tab.dataset.view));
    }
    switchView("browse");
}

/** Show one view, hide the other. */
function switchView(view) {
    $("view-browse").hidden = view !== "browse";
    $("view-ltm").hidden = view !== "ltm";
    // Scope pickers belong to the Overview; the explorer has its own filters.
    document.querySelector(".context-bar").hidden = view !== "browse";
    for (const tab of document.querySelectorAll(".view-tab")) {
        const isActive = tab.dataset.view === view;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
    }
}

async function connect(newConfig) {
    config = newConfig;
    client = createAgentMemoryClient(config);

    // Host breadcrumb next to the app title ("Inspector / localhost:8000").
    const host = $("app-host");
    host.textContent = new URL(config.url).host;
    host.hidden = false;

    workingPanel.reset();
    longTermPanel.reset();
    summaryPanel.reset();
    longTermPanel.setCapabilities({
        optimizeQuery: client.longTermMemory.supportsOptimizeQuery,
    });

    // Backends without a working-memory writer (Cloud) don't get the
    // add-event affordance.
    $("working-add-button").hidden = !client.workingMemory.put;

    // Pick the most recent namespace + user + session before the first poll
    // fires. If discovery finds nothing for any of them, leave that field
    // null - working/LTM fetches will degrade to broader scopes ("show all"
    // or "(none)" filter) until the user picks a value from the pill.
    await autoPickFilters();
    renderConnectionPills();
    pushScopeToPanel();

    // List existing summary views (never auto-create - deletes must
    // stick). null = backend without summary-view support: hide the pane
    // and let records take the full explorer width.
    try {
        summaryViews = await listSummaryViews(client);
    } catch (err) {
        summaryViews = [];
        setStatus(`couldn't list summary views: ${err.message}`);
    }
    summaryPanel.setAvailable(summaryViews !== null);

    await refreshAll();
}

/**
 * Run discovery on the now-live client to seed config.namespace +
 * config.userId + config.sessionId with the most recently active values.
 * discoverFilters() preserves LTM-scan order, so users[0] / namespaces[0]
 * = most recent. listSessions() returns ordered sessions; we take the first.
 */
async function autoPickFilters() {
    try {
        lastDiscovery = await client.discovery.filters();
        if (lastDiscovery.namespaces.length > 0)
            config.namespace = lastDiscovery.namespaces[0];
        if (lastDiscovery.users.length > 0)
            config.userId = lastDiscovery.users[0];
    } catch (err) {
        setStatus(`couldn't discover filters: ${err.message}`);
    }
    const sessions = await refreshSessionList();
    if (sessions.length > 0) config.sessionId = sessions[0];
}

/**
 * Re-list sessions for the current user/namespace scope and feed the
 * result into the LTM panel's session multi-select.
 */
async function refreshSessionList() {
    try {
        knownSessions = await client.sessions.list(
            config.userId,
            config.namespace,
        );
        longTermPanel.setSessions(knownSessions);
        return knownSessions;
    } catch (err) {
        setStatus(`couldn't list sessions: ${err.message}`);
        knownSessions = [];
        longTermPanel.setSessions([]);
        return [];
    }
}

function renderConnectionPills() {
    const pills = $("connection-pills");
    pills.innerHTML = "";

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
 * in sync), push the new context into the LTM panel, reset the panes, and
 * trigger a fresh poll.
 */
async function applyFilterChange({ namespace, userId, sessionId }) {
    const changedScopeKey =
        namespace !== undefined || userId !== undefined;

    if (namespace !== undefined) config.namespace = namespace;
    if (userId !== undefined) config.userId = userId;

    if (changedScopeKey) {
        const sessions = await refreshSessionList();
        config.sessionId = sessions[0] ?? null;
    } else if (sessionId !== undefined) {
        config.sessionId = sessionId;
    }

    renderConnectionPills();
    pushScopeToPanel();
    workingPanel.reset();
    longTermPanel.reset();
    await refreshAll();
}

/** Mirror the shared scope + discovered options into the LTM panel. */
function pushScopeToPanel() {
    longTermPanel.setScopeOptions({
        users: lastDiscovery.users,
        namespaces: lastDiscovery.namespaces,
        userId: config.userId,
        namespace: config.namespace,
        supportsNamespaces: client.supportsNamespaces,
    });
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
    if (!client) return;
    // No session picked - show the empty state but keep the header height.
    if (!config?.sessionId) {
        workingPanel.render(null);
        return;
    }
    try {
        const workingMemory = await client.workingMemory.get(
            config.sessionId,
            config.userId,
            config.namespace,
        );
        workingPanel.render(workingMemory);
        refreshers.working.markRefreshed();
        setStatus(`working memory updated ${timeStr()}`);
    } catch (err) {
        setStatus(`working memory: ${err.message}`);
    }
}

/** Overview long-term pane: scoped to the picked session. */
async function pollOverview() {
    if (!client) return;
    try {
        const data = await client.longTermMemory.search(config.userId, config.namespace, {
            sessionIds: config.sessionId ? [config.sessionId] : [],
        });
        longTermPanel.renderOverview(data.memories ?? []);
        refreshers.overview.markRefreshed();
    } catch (err) {
        setStatus(`long-term memory: ${err.message}`);
    }
}

/** Records pane (LTM tab): the explorer's own filter set. */
async function pollRecords() {
    if (!client) return;
    try {
        const data = await client.longTermMemory.search(
            config.userId,
            config.namespace,
            longTermPanel.getFilter(),
        );
        longTermPanel.renderRecords(data.memories ?? []);
        refreshers.records.markRefreshed();
        setStatus(`records updated ${timeStr()}`);
    } catch (err) {
        setStatus(`records: ${err.message}`);
    }
}

async function pollSummaries() {
    if (!client || summaryViews === null) return;
    try {
        summaryViews = (await client.summaryViews.list()) ?? [];
    } catch (err) {
        setStatus(`summary views: ${err.message}`);
        return;
    }

    // Partition filters must match a view's group_by keys exactly - a
    // user_id filter on a session-grouped view returns nothing. So user is
    // pushed server-side only for user-grouped views; session-grouped
    // partitions are listed unfiltered and scoped client-side to the
    // user's known sessions.
    const partitionLists = await Promise.all(
        summaryViews.map((view) =>
            client.summaryViews
                .listPartitions(
                    view.id,
                    config.userId && (view.group_by ?? []).includes("user_id")
                        ? { user_id: config.userId }
                        : {},
                )
                .then((list) => scopePartitions(view, list ?? []))
                .catch(() => []),
        ),
    );

    const partitions = {};
    summaryViews.forEach((view, i) => {
        partitions[view.id] = partitionLists[i];
    });

    summaryPanel.render({ views: summaryViews, partitions });
    refreshers.summary.markRefreshed();
    return partitions;
}

/** Client-side scope for session-grouped views (see pollSummaries). */
function scopePartitions(view, partitions) {
    if (!config.userId || !(view.group_by ?? []).includes("session_id")) {
        return partitions;
    }
    return partitions.filter((p) =>
        knownSessions.includes(p.group?.session_id),
    );
}

/**
 * Per-card recompute (runs the LLM synchronously server-side). The group
 * comes from the card's partition, so it always matches the view's
 * group_by keys.
 */
async function handleSummaryRecompute(viewId, group, button) {
    if (!client || button.disabled) return;
    button.disabled = true;
    button.classList.add("is-spinning");
    setStatus("recomputing summary…");
    try {
        await client.summaryViews.runPartition(viewId, group);
        setStatus(`summary recomputed ${timeStr()}`);
        await pollSummaries();
    } catch (err) {
        setStatus(`summary refresh failed: ${err.message}`);
        button.disabled = false;
        button.classList.remove("is-spinning");
    }
}

/** Create whichever default views are missing, then refresh the pane. */
async function handleCreateDefaultViews() {
    if (!client?.summaryViews) return;
    setStatus("creating default views…");
    try {
        summaryViews = await createDefaultViews(client, summaryViews ?? []);
        await pollSummaries();
        setStatus(`default views ready ${timeStr()}`);
    } catch (err) {
        setStatus(`create views failed: ${err.message}`);
    }
}

async function handleDeleteSummaryView(viewId) {
    if (!client?.summaryViews) return;
    try {
        await client.summaryViews.delete(viewId);
        setStatus("summary view deleted");
        await pollSummaries();
    } catch (err) {
        setStatus(`delete view failed: ${err.message}`);
    }
}

/**
 * Recompute ALL partitions of a view. The server runs it as an async
 * background task, so keep refetching (bounded) until its partitions
 * appear; the generate control stays disabled meanwhile.
 */
async function handleRunSummaryView(viewId) {
    if (!client?.summaryViews) return;
    summaryPanel.setRunning(viewId, true);
    await pollSummaries(); // repaint to disable the control
    setStatus("computing summaries…");
    try {
        await client.summaryViews.run(viewId);
        for (let attempt = 0; attempt < RUN_VIEW_POLL_ATTEMPTS; attempt += 1) {
            await delay(RUN_VIEW_POLL_DELAY_MS);
            const partitions = await pollSummaries();
            if ((partitions?.[viewId] ?? []).length) break;
        }
        setStatus(`summaries computed ${timeStr()}`);
    } catch (err) {
        setStatus(`compute failed: ${err.message}`);
    } finally {
        summaryPanel.setRunning(viewId, false);
        await pollSummaries();
    }
}

// ---------- add session event ----------

function initAddEventDialog() {
    const dialog = $("add-event-dialog");

    $("working-add-button").addEventListener("click", () => {
        $("add-event-session").value = config?.sessionId ?? "";
        $("add-event-content").value = "";
        dialog.showModal();
        $("add-event-content").focus();
    });

    $("add-event-cancel").addEventListener("click", () => dialog.close());

    $("add-event-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const sessionId = $("add-event-session").value.trim();
        const role = $("add-event-role").value;
        const content = $("add-event-content").value.trim();
        if (!sessionId || !content) return;
        try {
            await appendSessionEvent(sessionId, role, content);
            dialog.close();
        } catch (err) {
            setStatus(`add event failed: ${err.message}`);
        }
    });
}

/**
 * Append one message to a session's working memory via read-modify-write
 * (Redis Agent Memory's PUT replaces the whole working-memory record).
 * Works for brand-new session ids too - a missing session reads as empty
 * and the PUT creates it.
 */
async function appendSessionEvent(sessionId, role, content) {
    let current = {};
    try {
        current = await client.workingMemory.get(
            sessionId,
            config.userId,
            config.namespace,
        );
    } catch {
        // No working memory yet for this session id - start fresh.
    }

    const messages = [...(current.messages ?? []), { role, content }];
    await client.workingMemory.put(sessionId, {
        session_id: sessionId,
        user_id: current.user_id ?? config.userId ?? null,
        namespace: current.namespace ?? config.namespace ?? null,
        context: current.context ?? null,
        data: current.data ?? {},
        memories: current.memories ?? [],
        messages,
    });

    setStatus(`event added to ${sessionId}`);

    // A new session id becomes the connected session so the working pane
    // shows what was just written.
    if (config.sessionId !== sessionId) {
        config.sessionId = sessionId;
        await refreshSessionList();
        renderConnectionPills();
        workingPanel.reset();
    }
    await pollWorking();
    // Long-term extraction runs async server-side - a few detached
    // refetches surface the extracted flag and new records without holding
    // the submit open.
    followUpAfterExtraction();
}

/**
 * Detached refetches of working + overview long-term memory after an added
 * event, so the extraction flag flips and new records appear on their own.
 * Not awaited - the dialog's submit must not hang on these.
 */
function followUpAfterExtraction() {
    const startSession = config.sessionId;
    for (const wait of EXTRACTION_FOLLOW_UP_DELAYS_MS) {
        setTimeout(() => {
            // Bail if the user navigated to another session meanwhile.
            if (config.sessionId !== startSession) return;
            pollWorking();
            pollOverview();
        }, wait);
    }
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
        await Promise.all([pollRecords(), pollOverview()]);
    } catch (err) {
        setStatus(`delete failed: ${err.message}`);
    }
}

function setStatus(s) {
    $("status-line").textContent = s;
}
