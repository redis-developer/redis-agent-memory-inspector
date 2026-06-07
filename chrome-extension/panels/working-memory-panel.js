/**
 * Working-memory pane - renders the current session's messages + summary.
 *
 * Owns its small piece of state: which message IDs we've already shown.
 * That set drives the "new memory" flash animation - each id flashes once
 * the first time it appears, then is muted on subsequent re-renders.
 */

import { $ } from "../lib/dom.js";
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
 * for fetching `wm` from AMS; this function just paints.
 */
export function render(wm) {
    const messages = wm.messages ?? [];
    $("working-stats").textContent = `${messages.length} msg${
        messages.length === 1 ? "" : "s"
    }`;

    const list = $("working-list");
    list.innerHTML = "";
    for (const msg of messages) {
        const isNew = msg.id !== undefined && !seenIds.has(msg.id);
        if (msg.id !== undefined) seenIds.add(msg.id);

        const card = document.createElement("article");
        card.className = "card" + (isNew ? " is-new" : "");

        const meta = document.createElement("div");
        meta.className = "card-meta";

        const role = document.createElement("span");
        role.className = `role-tag role-${msg.role ?? "user"}`;
        role.textContent = msg.role ?? "user";
        meta.appendChild(role);

        if (msg.created_at) {
            const when = document.createElement("time");
            when.dateTime = msg.created_at;
            when.textContent = formatDateTime(msg.created_at);
            when.title = relativeTime(msg.created_at);
            meta.appendChild(when);
        }

        const flag = msg.discrete_memory_extracted;
        if (flag === "t" || flag === "f") {
            const extracted = document.createElement("span");
            extracted.className =
                "extracted-flag " + (flag === "t" ? "is-extracted" : "is-pending");
            extracted.textContent = flag === "t" ? "extracted ✓" : "extract pending";
            meta.appendChild(extracted);
        }

        card.appendChild(meta);

        const text = document.createElement("p");
        text.className = "card-text";
        text.textContent = msg.content ?? "";
        card.appendChild(text);

        const item = document.createElement("li");
        item.appendChild(card);
        list.appendChild(item);
    }

    if (wm.summary && typeof wm.summary === "string") {
        $("working-summary").hidden = false;
        $("working-summary-text").textContent = wm.summary;
    } else {
        $("working-summary").hidden = true;
    }
}
