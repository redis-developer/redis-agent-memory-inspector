/**
 * Working-memory pane - renders the current session's messages + summary.
 *
 * Owns its small piece of state: which message IDs we've already shown.
 * That set drives the "new memory" flash animation - each id flashes once
 * the first time it appears, then is muted on subsequent re-renders.
 *
 * Card structure lives in #working-card-template in index.html (placed right
 * after the #working-list it renders into). Slotting happens via
 * querySelector against the cloned template.
 */

import { $, fromTemplate } from "../lib/dom.js";
import { formatDateTime, relativeTime } from "../lib/format.js";

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
    $("working-summary").hidden = true;
    $("working-summary-text").textContent = "";
}

/**
 * Render the pane from a working-memory response. Caller is responsible
 * for fetching `workingMemory` from Redis Agent Memory; this function just paints.
 */
export function render(workingMemory) {
    const messages = workingMemory.messages ?? [];
    $("working-stats").textContent = `${messages.length} message${
        messages.length === 1 ? "" : "s"
    }`;

    const list = $("working-list");
    list.innerHTML = "";
    for (const message of messages) {
        list.appendChild(buildCard(message));
    }

    if (workingMemory.summary && typeof workingMemory.summary === "string") {
        $("working-summary").hidden = false;
        $("working-summary-text").textContent = workingMemory.summary;
    } else {
        $("working-summary").hidden = true;
    }
}

/**
 * Clone the working-card template and fill its slots from a single
 * message. The template's structure is in index.html; this function is
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
