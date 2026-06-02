/**
 * Entry point - wires DOM events to panel modules and the polling controller.
 *
 * Lifecycle:
 *   1. On DOMContentLoaded, show the connect panel for the user to fill in.
 *   2. After Connect, start the visibility-aware poller.
 *
 * The inspector holds no persistent state - every open of the window starts
 * from a clean connect form. `cfg` lives only in this module for the
 * lifetime of the window.
 */

import { $, escape } from "./lib/dom.js";
import { createAmsClient } from "./lib/ams-client.js";
import { createPoller } from "./lib/polling.js";
import { timeStr } from "./lib/format.js";
import { ensureSummaryViews } from "./lib/summary-views.js";
import * as workingPanel from "./panels/working-memory-panel.js";
import * as longTermPanel from "./panels/long-term-memory-panel.js";
import * as connectPanel from "./panels/connect-panel.js";

// Fallback poll cadences when the cfg from the connect panel doesn't supply
// explicit values (the form provides them by default, so this rarely fires).
const WORKING_MEMORY_REFRESH_MS = 3000;
const LONG_TERM_MEMORY_REFRESH_MS = 5000;

let cfg = null;
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

    $("reconfigure-btn").addEventListener("click", () => {
        poller?.stop();
        connectPanel.show({ seed: cfg ?? {}, onConnect: connect });
    });

    $("refresh-btn").addEventListener("click", refreshNow);

    // Working-memory clear: session-level deletion. Confirms before firing
    // because the operation is destructive (no soft delete, no undo).
    $("working-clear-btn").addEventListener("click", handleWorkingClear);

    // Summary-view refresh: forces AMS to re-run the LLM for the active
    // scope's partition. Disabled while in flight to prevent concurrent
    // runs; the spinning class on the icon signals progress.
    $("ltm-summary-refresh").addEventListener("click", handleSummaryRefresh);
});

function isCompleteCfg(c) {
    // userId is optional - AMS treats user_id as optional metadata on every
    // endpoint, and apps like redish key by namespace+sessionId instead.
    // Requiring it here was making the extension stricter than AMS.
    return Boolean(c?.url && c?.sessionId);
}

async function connect(newCfg) {
    cfg = newCfg;
    client = createAmsClient(cfg);
    workingPanel.reset();
    longTermPanel.reset();

    $("connect-panel").hidden = true;
    $("inspector-view").hidden = false;

    renderConnectionPills(newCfg);
    $("connection-pills").hidden = false;
    $("reconfigure-btn").hidden = false;
    $("refresh-btn").hidden = false;

    // Fire-and-forget the SummaryView bootstrap. Failure leaves
    // summaryViewIds = null, which the LTM panel reads as "no banners for
    // this connection" - we don't block polling on it.
    summaryViewIds = await ensureSummaryViews(client);

    poller = createPoller({
        onWorking: pollWorking,
        onLongTerm: pollLongTerm,
        workingMs: cfg.workingMemoryRefreshMs ?? WORKING_MEMORY_REFRESH_MS,
        longTermMs: cfg.longTermMemoryRefreshMs ?? LONG_TERM_MEMORY_REFRESH_MS,
    });
    poller.start();
}

function renderConnectionPills(c) {
    const pills = $("connection-pills");
    pills.innerHTML = "";
    pills.appendChild(pill("url", new URL(c.url).host));
    if (c.namespace) pills.appendChild(pill("ns", c.namespace));
    pills.appendChild(pill("user", c.userId));
    pills.appendChild(pill("session", c.sessionId));
}

function pill(key, value) {
    const el = document.createElement("span");
    el.className = "pill";
    el.innerHTML =
        `<span class="pill-key">${key}</span>` +
        `<span class="pill-value">${escape(value)}</span>`;
    return el;
}

async function pollWorking() {
    if (!client) return;
    try {
        const wm = await client.getWorkingMemory(
            cfg.sessionId,
            cfg.userId,
            cfg.namespace,
        );
        workingPanel.render(wm);
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
            scope === "session"
                ? { ...baseFilter, sessionId: cfg.sessionId }
                : baseFilter;
        const data = await client.searchLongTermMemory(
            cfg.userId,
            cfg.namespace,
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
    const btn = $("ltm-summary-refresh");
    if (btn.disabled) return; // already in flight - prevent concurrent runs
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
            ? { session_id: cfg.sessionId }
            : { user_id: cfg.userId };
    btn.disabled = true;
    btn.classList.add("is-spinning");
    setStatus("recomputing summary…");
    try {
        const partition = await client.runSummaryViewPartition(viewId, group);
        longTermPanel.setSummary(partition);
        setStatus(`summary recomputed ${timeStr()}`);
    } catch (err) {
        setStatus(`summary refresh failed: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.classList.remove("is-spinning");
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
            ? { session_id: cfg.sessionId }
            : { user_id: cfg.userId };
    const partitions = await client.listSummaryViewPartitions(viewId, filters);
    // Empty array → pass `{}` so the banner shows the empty-state copy
    // and keeps the ↻ refresh button reachable. Populated → pass the
    // partition itself.
    longTermPanel.setSummary(partitions?.[0] ?? {});
}

async function refreshNow() {
    if (!cfg) return;
    const btn = $("refresh-btn");
    btn.classList.add("is-spinning");
    setTimeout(() => btn.classList.remove("is-spinning"), 400);
    await poller?.runNow();
}

async function handleWorkingClear() {
    if (!client) return;
    const ok = confirm(
        `Clear working memory for session "${cfg.sessionId}"?\n\nAll messages and the running summary will be deleted. This cannot be undone.`,
    );
    if (!ok) return;
    try {
        await client.deleteWorkingMemory(
            cfg.sessionId,
            cfg.userId,
            cfg.namespace,
        );
        setStatus(`working memory cleared for ${cfg.sessionId}`);
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
