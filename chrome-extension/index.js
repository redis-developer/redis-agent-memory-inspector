/**
 * Entry point - wires DOM events to panel modules and the polling controller.
 *
 * Lifecycle:
 *   1. On DOMContentLoaded, show the connect panel for the user to fill in.
 *   2. After Connect, discover users + sessions, auto-pick the most recent,
 *      then start the visibility-aware poller.
 *
 * The inspector holds no persistent state - every open of the window starts
 * from a clean connect form. `config` lives only in this module for the
 * lifetime of the window. User + session can be re-picked at any time from
 * the header picker pills without reconnecting.
 */

import { $, fromTemplate } from "./lib/dom.js";
import { createAmsClient } from "./lib/ams-client.js";
import { createPoller } from "./lib/polling.js";
import { timeStr } from "./lib/format.js";
import { ensureSummaryViews } from "./lib/summary-views.js";
import * as workingPanel from "./panels/working-memory-panel.js";
import * as longTermPanel from "./panels/long-term-memory-panel.js";
import * as connectPanel from "./panels/connect-panel.js";

// Fallback poll cadences when the config from the connect panel doesn't supply
// explicit values (the form provides them by default, so this rarely fires).
const WORKING_MEMORY_REFRESH_MS = 3000;
const LONG_TERM_MEMORY_REFRESH_MS = 5000;

let config = null;
let poller = null;
let client = null; // backend-specific AMS client, created on connect
let summaryViewIds = null; // { userProfileViewId, sessionProfileViewId } | null

document.addEventListener("DOMContentLoaded", async () => {
    // Long-term panel owns its filter state and per-card delete affordance.
    // We subscribe so a filter change triggers a refetch, and we provide a
    // delete handler that calls AMS then refetches.
    longTermPanel.init({
        onChange: pollLongTerm,
        onDelete: handleLongTermDelete,
    });

    connectPanel.show({ seed: {}, onConnect: connect });

    $("reconfigure-button").addEventListener("click", () => {
        poller?.stop();
        connectPanel.show({ seed: config ?? {}, onConnect: connect });
    });

    $("refresh-button").addEventListener("click", refreshNow);

    // Working-memory clear: session-level deletion. Confirms before firing
    // because the operation is destructive (no soft delete, no undo).
    $("working-clear-button").addEventListener("click", handleWorkingClear);

    // Summary-view refresh: forces AMS to re-run the LLM for the active
    // scope's partition. Disabled while in flight to prevent concurrent
    // runs; the spinning class on the icon signals progress.
    $("ltm-summary-refresh").addEventListener("click", handleSummaryRefresh);

    // Click-outside closes any open picker-pill popover. Mounted once so
    // each pill doesn't have to manage its own document listener.
    document.addEventListener("click", (e) => {
        for (const open of document.querySelectorAll(".pill-picker.is-open")) {
            if (!open.contains(e.target)) closePicker(open);
        }
    });
});

async function connect(newConfig) {
    config = newConfig;
    client = createAmsClient(config);
    workingPanel.reset();
    longTermPanel.reset();

    $("connect-panel").hidden = true;
    $("inspector-view").hidden = false;
    $("connection-pills").hidden = false;
    $("reconfigure-button").hidden = false;
    $("refresh-button").hidden = false;

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
 * Run discovery on the now-live client to seed config.namespace + config.userId +
 * config.sessionId with the most recently active values. discoverFilters()
 * preserves LTM-scan order, so users[0] / namespaces[0] = most recent.
 * listSessions() returns AMS-ordered sessions; we take the first.
 */
async function autoPickFilters() {
    try {
        const { users, namespaces } = await client.discoverFilters();
        if (namespaces.length > 0) config.namespace = namespaces[0];
        if (users.length > 0) config.userId = users[0];
    } catch (err) {
        setStatus(`couldn't discover filters: ${err.message}`);
    }
    try {
        const sessions = await client.listSessions(config.userId, config.namespace);
        if (sessions.length > 0) config.sessionId = sessions[0];
    } catch (err) {
        setStatus(`couldn't list sessions: ${err.message}`);
    }
}

function renderConnectionPills() {
    const pills = $("connection-pills");
    pills.innerHTML = "";
    pills.appendChild(staticPill("url", new URL(config.url).host));

    // Namespace pill - OSS only (Cloud has no namespace concept).
    if (config.backend !== "cloud") {
        pills.appendChild(
            pickerPill({
                key: "ns",
                value: config.namespace,
                allowNone: true,
                getOptions: async () => {
                    const { namespaces } = await client.discoverFilters();
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
                const { users } = await client.discoverFilters();
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
            getOptions: () => client.listSessions(config.userId, config.namespace),
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
            const sessions = await client.listSessions(
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
 * Sentinel value rendered in the datalist when `allowNone` is true.
 * Selecting this option (or clearing the input) commits a null pick.
 */
const NONE_SENTINEL = "(none)";

/**
 * Clickable pill that opens a popover combobox below itself. Structure
 * (trigger button + popover with search input, datalist, Apply) is
 * defined in #picker-pill-template in index.html; this function clones it,
 * fills the slots, and wires the interaction handlers.
 *
 * If `allowNone` is true, the popover surfaces a "(none)" entry at the top
 * of the suggestion list and treats either picking it or clearing the
 * input as `onPick(null)` - useful for filters that are optional in AMS
 * (user_id, namespace, session_id can all be unset to broaden the scope).
 *
 * Click-outside (handled at the document level in DOMContentLoaded) closes
 * the popover without firing.
 */
function pickerPill({ key, value, getOptions, onPick, allowNone = false }) {
    const wrapper = fromTemplate("picker-pill-template");

    wrapper.querySelector(".pill-key").textContent = key;
    wrapper.querySelector(".pill-value").textContent = value ?? NONE_SENTINEL;

    const popover = wrapper.querySelector(".pill-popover");
    const input = wrapper.querySelector(".pill-search");
    const datalist = wrapper.querySelector("datalist");
    const apply = wrapper.querySelector(".pill-popover-apply");
    const trigger = wrapper.querySelector(".pill-button");

    // Each cloned picker needs its own datalist id so <input list="...">
    // points at the right list (otherwise all pickers would share suggestions).
    const datalistId = `pill-options-${key}-${Math.random().toString(36).slice(2, 8)}`;
    datalist.id = datalistId;
    input.setAttribute("list", datalistId);
    input.placeholder = `Pick or type a ${key}…`;

    trigger.addEventListener("click", async (e) => {
        e.stopPropagation(); // don't trip the document click-outside handler
        if (wrapper.classList.contains("is-open")) {
            closePicker(wrapper);
            return;
        }
        // Close any other open pickers first.
        for (const other of document.querySelectorAll(".pill-picker.is-open")) {
            if (other !== wrapper) closePicker(other);
        }
        wrapper.classList.add("is-open");
        popover.hidden = false;
        input.value = value ?? "";
        // Populate the datalist lazily so we always see fresh options when
        // the user re-opens the picker. "(none)" goes first so it's the
        // most reachable choice when collapsing back to a broader scope.
        datalist.innerHTML = "";
        if (allowNone) {
            const noneOption = document.createElement("option");
            noneOption.value = NONE_SENTINEL;
            datalist.appendChild(noneOption);
        }
        try {
            const options = await getOptions();
            for (const v of options) {
                const opt = document.createElement("option");
                opt.value = v;
                datalist.appendChild(opt);
            }
        } catch (err) {
            setStatus(`couldn't load ${key} options: ${err.message}`);
        }
        input.focus();
        input.select();
    });

    function commit() {
        const raw = input.value.trim();
        closePicker(wrapper);
        // Empty input or the explicit "(none)" sentinel both mean "clear
        // this filter" when the pill allows none; otherwise an empty input
        // is just a no-op (you can't unset a required field).
        if (allowNone && (raw === "" || raw === NONE_SENTINEL)) {
            if (value !== null) onPick(null);
            return;
        }
        if (raw && raw !== value) onPick(raw);
    }

    apply.addEventListener("click", commit);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commit();
        } else if (e.key === "Escape") {
            closePicker(wrapper);
        }
    });
    // Picking from the datalist fires `change` (not just `input`) - commit
    // straight away so the user doesn't have to click Apply.
    input.addEventListener("change", commit);

    return wrapper;
}

function closePicker(wrapper) {
    wrapper.classList.remove("is-open");
    const popover = wrapper.querySelector(".pill-popover");
    if (popover) popover.hidden = true;
}

async function pollWorking() {
    if (!client || !config?.sessionId) return;
    try {
        const workingMemory = await client.getWorkingMemory(
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
        // "This session" tab folds session_id into the filter so AMS scopes
        // the search to memories extracted from the connected session.
        // "Across sessions" leaves it out, preserving the existing
        // user-wide view.
        const scope = longTermPanel.getScope();
        const baseFilter = longTermPanel.getFilter();
        const filter =
            scope === "session" && config.sessionId
                ? { ...baseFilter, sessionId: config.sessionId }
                : baseFilter;
        const data = await client.searchLongTermMemory(
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
    // try/catch so a summary-views 404 (Cloud, or AMS too old) doesn't mask
    // the LTM update above.
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
    // with - AMS rejects extras with HTTP 400 ("group keys ... must exactly
    // match view.group_by"). session view is grouped by session_id only;
    // user view by user_id only.
    const group =
        scope === "session"
            ? { session_id: config.sessionId }
            : { user_id: config.userId };
    button.disabled = true;
    button.classList.add("is-spinning");
    setStatus("recomputing summary…");
    try {
        const partition = await client.runSummaryViewPartition(viewId, group);
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
    const partitions = await client.listSummaryViewPartitions(viewId, filters);
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
        await client.deleteWorkingMemory(
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
        await client.deleteLongTermMemory([memoryId]);
        setStatus(`deleted memory ${memoryId.slice(0, 12)}…`);
        await pollLongTerm();
    } catch (err) {
        setStatus(`delete failed: ${err.message}`);
    }
}

function setStatus(s) {
    $("status-line").textContent = s;
}
