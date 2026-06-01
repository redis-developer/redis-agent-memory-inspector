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

const seenIds = new Set();
const filter = { text: "", topics: [], entities: [], optimizeQuery: false };
let searchDebounce = null;
let onChangeCallback = null;
let onDeleteCallback = null;

export function reset() {
    seenIds.clear();
}

export function getFilter() {
    return filter;
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
