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
});

function isCompleteCfg(c) {
    // userId is optional - AMS treats user_id as optional metadata on every
    // endpoint, and apps like redish key by namespace+sessionId instead.
    // Requiring it here was making the extension stricter than AMS.
    return Boolean(c?.url && c?.sessionId);
}

function connect(newCfg) {
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
        const data = await client.searchLongTermMemory(
            cfg.userId,
            cfg.namespace,
            longTermPanel.getFilter(),
        );
        longTermPanel.render(data.memories ?? []);
        setStatus(`long-term memory updated ${timeStr()}`);
    } catch (err) {
        setStatus(`long-term memory: ${err.message}`);
    }
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
