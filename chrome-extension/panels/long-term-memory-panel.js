/**
 * Long-term-memory pane - renders ranked search results, owns the active
 * filter state, and wires search input + chip clicks + filter pills.
 *
 * Filter state lives in this module so that all the input handling stays
 * local. The entry point calls `init({ onChange })` to subscribe; whenever
 * the filter mutates we invoke `onChange` so the caller can refetch and
 * re-render. `getFilter()` exposes the current shape to the caller, which
 * passes it into `searchLongTermMemory(...)`.
 */

import { $, escape } from "../lib/dom.js";
import { formatDateTime, relativeTime } from "../lib/format.js";

/**
 * Render the SummaryView partition into the banner above the search
 * toolbar. Three states:
 *
 *   setSummary(null)         → hide the banner entirely. For Cloud
 *                              (no summary views) or when the bootstrap
 *                              never completed.
 *   setSummary({})           → show the banner with an empty-state
 *                              message so the ↻ refresh button stays
 *                              reachable (lets the user bootstrap the
 *                              first partition by clicking refresh
 *                              instead of waiting on AMS's hourly
 *                              continuous worker).
 *   setSummary(partition)    → show the populated banner.
 *
 * Long summaries are clamped to 4 lines in CSS; if the content
 * overflows the clamp we expose a "Show more / Show less" toggle.
 */
export function setSummary(partition) {
    const banner = $("ltm-summary-banner");
    if (partition === null) {
        banner.hidden = true;
        return;
    }
    banner.hidden = false;
    const textEl = $("ltm-summary-text");
    const metaEl = $("ltm-summary-meta");
    const toggleEl = $("ltm-summary-toggle");

    if (!partition || !partition.summary) {
        banner.classList.add("is-empty");
        textEl.textContent =
            "No summary yet for this scope. Click ↻ to generate one.";
        metaEl.textContent = "";
        toggleEl.hidden = true;
        return;
    }

    banner.classList.remove("is-empty");
    textEl.textContent = partition.summary;
    const meta = [];
    if (typeof partition.memory_count === "number") {
        meta.push(
            `from ${partition.memory_count} memor${
                partition.memory_count === 1 ? "y" : "ies"
            }`,
        );
    }
    if (partition.computed_at) {
        meta.push(`computed ${relativeTime(partition.computed_at)}`);
    }
    metaEl.textContent = meta.join(" · ");

    // Defer overflow detection one frame so layout has settled with the
    // new text content before we measure.
    requestAnimationFrame(() => updateSummaryToggleVisibility());
}

/**
 * Show the toggle only when collapsed text would actually be truncated.
 * Briefly expands to measure the full scrollHeight, then restores the
 * previous expand/collapse state. Cheap (no reflow churn the user can
 * see) and avoids a "Show more" affordance for short summaries that
 * already fit in the clamp.
 */
function updateSummaryToggleVisibility() {
    const banner = $("ltm-summary-banner");
    const textEl = $("ltm-summary-text");
    const toggleEl = $("ltm-summary-toggle");

    const wasExpanded = banner.classList.contains("is-expanded");
    banner.classList.remove("is-expanded");
    const collapsedHeight = textEl.clientHeight;
    banner.classList.add("is-expanded");
    const expandedHeight = textEl.scrollHeight;
    if (!wasExpanded) banner.classList.remove("is-expanded");

    const overflows = expandedHeight > collapsedHeight + 2;
    toggleEl.hidden = !overflows;
    toggleEl.textContent = wasExpanded ? "Show less" : "Show more";
}

const seenIds = new Set();
const filter = { text: "", topics: [], entities: [], optimizeQuery: false };
// Tab scope: "all" = every memory for the user (default, existing behavior);
// "session" = only memories whose session_id matches the connected session.
let scope = "all";
let searchDebounce = null;
let onChangeCallback = null;
let onDeleteCallback = null;

// Cached context (userId + namespace) so the subtitle can re-derive itself
// when the scope tab changes without the caller having to push context
// again. `index.js` calls `setContext({ ... })` after every cfg mutation.
let context = { userId: null, namespace: null, hasSession: false };

export function reset() {
    seenIds.clear();
    setSummary(null);
    // Wipe the rendered list + stats so stale cards don't linger across a
    // reconfigure. The next `render()` will repaint from the new fetch.
    $("longterm-list").innerHTML = "";
    $("longterm-stats").textContent = "-";
}

export function getFilter() {
    return filter;
}

export function getScope() {
    return scope;
}

/**
 * Wire the search input and optimize toggle. Idempotent - safe to call once
 * at app startup.
 *
 * - `onChange` fires (debounced for text input, immediate for everything
 *   else) whenever the filter mutates; caller uses it to refetch.
 * - `onDelete(memoryId)` fires when the user clicks the ✕ on a card and
 *   confirms; caller is responsible for the DELETE call + refresh.
 */
export function init({ onChange, onDelete }) {
    onChangeCallback = onChange;
    onDeleteCallback = onDelete;

    $("ltm-search").addEventListener("input", (event) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            filter.text = event.target.value.trim();
            onChangeCallback?.();
        }, 300);
    });

    $("ltm-optimize").addEventListener("change", (event) => {
        filter.optimizeQuery = event.target.checked;
        onChangeCallback?.();
    });

    // Show more / Show less for the clamped summary text.
    $("ltm-summary-toggle").addEventListener("click", () => {
        const banner = $("ltm-summary-banner");
        const toggleEl = $("ltm-summary-toggle");
        const nowExpanded = banner.classList.toggle("is-expanded");
        toggleEl.textContent = nowExpanded ? "Show less" : "Show more";
    });

    // Tabs: pick a button by `data-scope`, mirror state into `scope`, update
    // pressed visuals + subtitle, and fire onChange so the caller refetches
    // with the new filter. The "session" tab refuses to activate when no
    // session is currently selected - setContext() disables it visually,
    // but a guard here keeps keyboard activation honest too.
    for (const tab of document.querySelectorAll(".pane-tab")) {
        tab.addEventListener("click", () => {
            const next = tab.dataset.scope;
            if (!next || next === scope) return;
            if (next === "session" && !context.hasSession) return;
            scope = next;
            paintActiveTab();
            updateSubtitle();
            // Reset the "is-new" highlight when switching scopes - the set
            // of visible memories changes completely, and stale ids would
            // leave previously-seen records unflashed in the new view.
            seenIds.clear();
            onChangeCallback?.();
        });
    }
}

/**
 * Push the current filter context into the panel. Two effects:
 *
 *   1. Disable "This session" tab when there's no session to scope to. If
 *      the tab was active when session got cleared, fall back to "all" and
 *      fire onChange so the caller repaints with the broader scope.
 *   2. Re-derive the subtitle text from the userId / namespace so it
 *      accurately describes what's actually being filtered.
 *
 * Called by index.js after every cfg mutation (initial connect + every
 * picker-pill change).
 */
export function setContext({ userId, namespace, hasSession }) {
    context = { userId, namespace, hasSession };

    const sessionTab = document.querySelector('.pane-tab[data-scope="session"]');
    if (sessionTab) {
        sessionTab.disabled = !hasSession;
        sessionTab.classList.toggle("is-disabled", !hasSession);
        if (hasSession) {
            sessionTab.removeAttribute("title");
            sessionTab.setAttribute("aria-disabled", "false");
        } else {
            sessionTab.setAttribute("title", "Pick a session to scope to");
            sessionTab.setAttribute("aria-disabled", "true");
        }
    }

    // If session went away mid-flight, demote scope back to "all" so the
    // user isn't stuck looking at an empty session-filtered list.
    if (!hasSession && scope === "session") {
        scope = "all";
        paintActiveTab();
        seenIds.clear();
        onChangeCallback?.();
    }

    updateSubtitle();
}

function paintActiveTab() {
    for (const t of document.querySelectorAll(".pane-tab")) {
        const isActive = t.dataset.scope === scope;
        t.classList.toggle("is-active", isActive);
        t.setAttribute("aria-selected", String(isActive));
    }
}

function updateSubtitle() {
    const subtitle = $("longterm-subtitle");
    if (!subtitle) return;
    if (scope === "session") {
        subtitle.textContent = "for the connected session only";
        return;
    }
    if (context.userId) {
        subtitle.textContent = "across all sessions for this user";
    } else if (context.namespace) {
        subtitle.textContent = `across all sessions in "${context.namespace}"`;
    } else {
        subtitle.textContent = "across all sessions";
    }
}

function toggleFilter(label, value) {
    const bucket = label === "topics" ? "topics" : "entities";
    const list = filter[bucket];
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
    else list.push(value);
    onChangeCallback?.();
}

function clearAllFilters() {
    filter.text = "";
    filter.topics = [];
    filter.entities = [];
    $("ltm-search").value = "";
    onChangeCallback?.();
}

export function render(memories) {
    $("longterm-stats").textContent = `${memories.length} record${
        memories.length === 1 ? "" : "s"
    }`;

    // Sort chronologically (oldest first) so the long-term pane scrolls the
    // same direction as working memory - new memories appear at the bottom.
    // AMS's default order isn't chronological (it's relevance-ranked when
    // there's a text query, and otherwise implementation-defined). Sorting
    // client-side gives consistent UX in all modes. The `score` field on
    // each card still shows similarity if you want to gauge ranking.
    const sorted = [...memories].sort((a, b) => {
        const ta = new Date(a.created_at ?? 0).getTime();
        const tb = new Date(b.created_at ?? 0).getTime();
        return ta - tb;
    });

    const list = $("longterm-list");
    list.innerHTML = "";
    for (const memory of sorted) {
        const isNew = memory.id && !seenIds.has(memory.id);
        if (memory.id) seenIds.add(memory.id);

        const card = document.createElement("article");
        card.className = "card" + (isNew ? " is-new" : "");

        const meta = document.createElement("div");
        meta.className = "card-meta";

        const type = document.createElement("span");
        const memoryType = memory.memory_type ?? "semantic";
        type.className = `type-badge type-${memoryType}`;
        type.textContent = memoryType;
        meta.appendChild(type);

        if (memory.created_at) {
            const when = document.createElement("time");
            when.dateTime = memory.created_at;
            when.textContent = formatDateTime(memory.created_at);
            when.title = relativeTime(memory.created_at);
            meta.appendChild(when);
        }

        // Source session - inline, right after the timestamp. Records the
        // session this memory was extracted from. Some memories (seeded
        // outside any conversation, or otherwise untagged) have no
        // session_id, in which case we skip this entirely.
        if (memory.session_id) {
            const session = document.createElement("span");
            session.className = "card-meta-session";
            session.appendChild(document.createTextNode("from session: "));
            const code = document.createElement("code");
            code.textContent = memory.session_id;
            session.appendChild(code);
            meta.appendChild(session);
        }

        if (memory.id) {
            const idEl = document.createElement("span");
            idEl.className = "card-id";
            // First 6 + ellipsis + last 6 - ULIDs encode the timestamp in the
            // first ~10 chars and randomness in the last ~16, so trimming the
            // middle gives you both the "when it was created" prefix and the
            // "this one specifically" suffix at a glance. Full id still in title.
            const fullId = String(memory.id);
            idEl.textContent =
                fullId.length > 13
                    ? `${fullId.slice(0, 6)}…${fullId.slice(-6)}`
                    : fullId;
            idEl.title = `Memory ID: ${memory.id}`;
            meta.appendChild(idEl);
        }

        // Score is only present when AMS ranked this result (text query was
        // set). `score` is the composite (higher = better); `dist` is the raw
        // vector distance; `score_type` reveals which scoring strategy AMS used.
        if (typeof memory.score === "number") {
            const score = document.createElement("span");
            score.className = "score-badge";
            score.textContent = memory.score.toFixed(3);
            score.title =
                `score: ${memory.score.toFixed(4)}\n` +
                `dist:  ${memory.dist?.toFixed?.(4) ?? "-"}\n` +
                `type:  ${memory.score_type ?? "-"}`;
            meta.appendChild(score);
        }

        // Per-card delete - hover-revealed, confirms before firing. AMS
        // supports DELETE /v1/long-term-memory?memory_ids=…; the caller
        // handles the actual request via the onDelete callback.
        if (memory.id) {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "card-delete-btn";
            del.textContent = "✕";
            del.title = "Delete this memory";
            del.setAttribute("aria-label", "Delete memory");
            del.addEventListener("click", (event) => {
                event.stopPropagation();
                const snippet = (memory.text ?? "").slice(0, 100);
                const ok = confirm(
                    `Delete this memory?\n\n"${snippet}${memory.text?.length > 100 ? "…" : ""}"`,
                );
                if (ok) onDeleteCallback?.(memory.id);
            });
            meta.appendChild(del);
        }

        card.appendChild(meta);

        const text = document.createElement("p");
        text.className = "card-text";
        text.textContent = memory.text ?? "";
        card.appendChild(text);

        const topicsRow = renderChipRow("topics", memory.topics, "chip-topic");
        if (topicsRow) card.appendChild(topicsRow);

        const entitiesRow = renderChipRow("entities", memory.entities, "chip-entity");
        if (entitiesRow) card.appendChild(entitiesRow);

        const item = document.createElement("li");
        item.appendChild(card);
        list.appendChild(item);
    }

    renderActiveFilters();
}

/**
 * Labelled chip row - "topics: [chip1] [chip2] [chip3]". Returns `null` for
 * empty lists so the caller can skip appending instead of leaving a dangling
 * label. Labels mirror AMS's own field names so the UI matches the record shape.
 */
function renderChipRow(label, values, chipClass) {
    if (!values || values.length === 0) return null;
    const row = document.createElement("div");
    row.className = "chip-row";

    const labelEl = document.createElement("span");
    labelEl.className = "chip-row-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "chip-row-chips";
    for (const value of values) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `chip ${chipClass}`;
        chip.textContent = value;
        chip.title = `Click to filter by ${label.slice(0, -1)}: ${value}`;
        chip.addEventListener("click", () => toggleFilter(label, value));
        chipsWrap.appendChild(chip);
    }
    row.appendChild(chipsWrap);
    return row;
}

/**
 * Removable pills above the card list reflecting the active filter set, so
 * it's always obvious what's narrowing the results.
 */
function renderActiveFilters() {
    const container = $("ltm-active-filters");
    container.innerHTML = "";

    const append = (key, value, onRemove) => {
        const pill = document.createElement("span");
        pill.className = "filter-pill";
        pill.innerHTML =
            `<span class="filter-pill-key">${escape(key)}</span>` +
            `<span>${escape(value)}</span>`;
        const x = document.createElement("button");
        x.type = "button";
        x.className = "filter-pill-remove";
        x.textContent = "×";
        x.title = "Remove this filter";
        x.addEventListener("click", onRemove);
        pill.appendChild(x);
        container.appendChild(pill);
    };

    for (const topic of filter.topics) {
        append("topic", topic, () => toggleFilter("topics", topic));
    }
    for (const entity of filter.entities) {
        append("entity", entity, () => toggleFilter("entities", entity));
    }

    if (filter.topics.length || filter.entities.length) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "filter-pill-remove";
        clear.textContent = "clear all";
        clear.style.padding = "2px 8px";
        clear.style.borderRadius = "12px";
        clear.title = "Remove all filters";
        clear.addEventListener("click", clearAllFilters);
        container.appendChild(clear);
    }
}
