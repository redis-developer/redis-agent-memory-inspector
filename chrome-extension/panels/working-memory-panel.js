/**
 * Working-memory pane - renders the current session's messages + summary.
 *
 * Owns its small piece of state: which message IDs we've already shown.
 * That set drives the "new memory" flash animation - each id flashes once
 * the first time it appears, then is muted on subsequent re-renders.
 *
 * Card structure lives in #working-card-template in inspector.html (placed right
 * after the #working-list it renders into). Slotting happens via
 * querySelector against the cloned template.
 */

import { $, fromTemplate } from "../lib/dom.js";
import { formatDateTime, pluralize, relativeTime } from "../lib/format.js";

const seenIds = new Set();

/**
 * Wipe the pane back to its empty state. Called when connecting to a fresh
 * session (or when reconfiguring) - clears both the seen-id tracking and
 * the rendered DOM so a subsequent `render()` doesn't briefly show stale
 * cards from the previous session.
 */
export function reset() {
    seenIds.clear();
    $("working-list").innerHTML = "";
    $("working-stats").textContent = "-";
    setMetaRow(null);
}

/**
 * Render the pane from a working-memory response. Caller is responsible
 * for fetching `workingMemory` from Redis Agent Memory; this function just paints.
 * Pass `null` to show the "no session" state while keeping header height.
 */
export function render(workingMemory) {
    if (!workingMemory) {
        reset();
        $("working-stats").textContent = "no session selected";
        return;
    }

    const messages = workingMemory.messages ?? [];
    $("working-stats").textContent = pluralize(messages.length, "message");

    const list = $("working-list");
    list.innerHTML = "";
    const summary = summaryFrom(workingMemory);
    if (summary) {
        const item = document.createElement("li");
        item.appendChild(buildSummaryCard(summary));
        list.appendChild(item);
    }
    for (const message of messages) {
        list.appendChild(buildCard(message));
    }

    setMetaRow(workingMemory);
}

/**
 * Second header row: created timestamp, TTL, and the icon-only Clear.
 * `null` hides the values but the row stays (its min-height keeps the
 * header from shrinking when a scope has no working memory).
 */
function setMetaRow(workingMemory) {
    const createdItem = $("working-created").closest(".pane-meta-item");
    const ttlItem = $("working-ttl");
    const clearButton = $("working-clear-button");

    if (!workingMemory) {
        createdItem.hidden = true;
        ttlItem.hidden = true;
        clearButton.hidden = true;
        return;
    }

    clearButton.hidden = false;

    if (workingMemory.created_at) {
        createdItem.hidden = false;
        const time = $("working-created");
        time.dateTime = workingMemory.created_at;
        time.textContent = formatDateTime(workingMemory.created_at);
        time.title = `created ${relativeTime(workingMemory.created_at)}`;
    } else {
        createdItem.hidden = true;
    }

    const ttl = workingMemory.ttl_seconds;
    ttlItem.hidden = false;
    ttlItem.querySelector("code").textContent =
        typeof ttl === "number" ? `${ttl} s` : "No limit";
}

/**
 * Normalize the running summary across backends. OSS exposes it as
 * `context` (a plain string); Cloud exposes `summary` as a SessionSummary
 * object ({ text, updatedAt, summarizedEvents, ... }). Returns null when no
 * summary has been produced yet.
 */
function summaryFrom(workingMemory) {
    const { context, summary } = workingMemory;
    if (typeof context === "string" && context.trim()) {
        return { text: context };
    }
    if (
        summary &&
        typeof summary === "object" &&
        typeof summary.text === "string" &&
        summary.text.trim()
    ) {
        return {
            text: summary.text,
            updatedAt: summary.updatedAt,
            summarizedEvents: summary.summarizedEvents,
        };
    }
    if (typeof summary === "string" && summary.trim()) {
        return { text: summary };
    }
    return null;
}

/**
 * Build the leading summary list item. Shows the summary text and, when the
 * backend provides them (Cloud), a meta line with the folded-in event count
 * and last-updated time.
 */
function buildSummaryCard(summary) {
    const node = fromTemplate("working-summary-template");
    node.querySelector(".summary-text").textContent = summary.text;

    const parts = [];
    if (typeof summary.summarizedEvents === "number") {
        parts.push(pluralize(summary.summarizedEvents, "event"));
    }
    if (summary.updatedAt) {
        parts.push(formatDateTime(summary.updatedAt));
    }
    if (parts.length) {
        const metaEl = node.querySelector(".summary-meta");
        metaEl.hidden = false;
        metaEl.textContent = parts.join(" · ");
        if (summary.updatedAt) {
            metaEl.title = `updated ${relativeTime(summary.updatedAt)}`;
        }
    }
    return node;
}

/**
 * Clone the working-card template and fill its slots from a single
 * message. The template's structure is in inspector.html; this function is
 * only responsible for data binding and conditional visibility.
 */
function buildCard(message) {
    const node = fromTemplate("working-card-template");

    const isNew = message.id !== undefined && !seenIds.has(message.id);
    if (message.id !== undefined) seenIds.add(message.id);

    const card = node.querySelector(".card");
    if (isNew) card.classList.add("is-new");

    const role = message.role ?? "user";
    const roleEl = node.querySelector(".role-tag");
    roleEl.className = `role-tag role-${role}`;
    roleEl.textContent = role;

    if (message.created_at) {
        const when = node.querySelector("time");
        when.hidden = false;
        when.dateTime = message.created_at;
        when.textContent = formatDateTime(message.created_at);
        when.title = relativeTime(message.created_at);
    }

    const flag = message.discrete_memory_extracted;
    if (flag === "t" || flag === "f") {
        const flagEl = node.querySelector(".extracted-flag");
        flagEl.hidden = false;
        flagEl.classList.add(flag === "t" ? "is-extracted" : "is-pending");
        flagEl.textContent = flag === "t" ? "extracted ✓" : "extract pending";
    }

    node.querySelector(".card-text").textContent = message.content ?? "";

    return node;
}
