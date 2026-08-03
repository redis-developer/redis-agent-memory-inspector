/**
 * Long-term-memory records - the searchable list in the explorer
 * (Long-term memory tab) and the compact overview list (Overview tab).
 *
 * Filter state lives in this module so all the input handling stays
 * local. The entry point calls `init({ onChange })` to subscribe; whenever
 * the filter mutates we invoke `onChange` so the caller can refetch and
 * re-render. `getFilter()` exposes the current shape to the caller, which
 * passes it into `searchLongTermMemory(...)`.
 *
 * Every server-side tag filter gets a dropdown in the toolbar's filter
 * row: sessions, memory type, topics, entities (multi-select, `any`
 * semantics) plus user + namespace (single-select - they're the shared
 * connection scope, so picking one routes through the caller's
 * onScopeChange just like the Overview pills). Topic/entity chips on the
 * cards toggle the same filters.
 */

import { $, fromTemplate, makeCopyButton, wireClampToggle } from "../lib/dom.js";
import { formatDateTime, pluralize, relativeTime, shortId } from "../lib/format.js";

const MEMORY_TYPES = ["semantic", "episodic", "message"];

const seenIds = new Set();
// Distinct topic/entity values observed on this connection - feeds the
// dropdown option lists (the server has no enumeration endpoint).
const seenTopics = new Set();
const seenEntities = new Set();

const filter = {
    text: "",
    topics: [],
    entities: [],
    sessionIds: [],
    memoryTypes: [],
    optimizeQuery: false,
};
let knownSessions = [];
let scopeOptions = {
    users: [],
    namespaces: [],
    userId: null,
    namespace: null,
    supportsNamespaces: true,
};
let searchDebounce = null;
let onChangeCallback = null;
let onDeleteCallback = null;
let onScopeChangeCallback = null;

// Multi-select dropdown instances, repainted when their options change.
const dropdowns = new Map();

export function reset() {
    seenIds.clear();
    seenTopics.clear();
    seenEntities.clear();
    filter.sessionIds = [];
    filter.memoryTypes = [];
    // Wipe the rendered lists + stats so stale cards don't linger across a
    // reconfigure. The next `render()` will repaint from the new fetch.
    $("longterm-list").innerHTML = "";
    $("longterm-stats").textContent = "-";
    $("browse-longterm-list").innerHTML = "";
    $("browse-longterm-stats").textContent = "-";
    repaintDropdowns();
}

export function getFilter() {
    return filter;
}

/**
 * Wire the search input, optimize toggle and the filter row. Idempotent -
 * safe to call once at app startup.
 *
 * - `onChange` fires (debounced for text input, immediate for everything
 *   else) whenever the filter mutates; caller uses it to refetch.
 * - `onDelete(memoryId)` fires when the user clicks the ✕ on a card and
 *   confirms; caller is responsible for the DELETE call + refresh.
 * - `onScopeChange({ userId } | { namespace })` fires when the user/ns
 *   dropdowns pick a value - the caller owns that shared scope.
 */
export function init({ onChange, onDelete, onScopeChange }) {
    onChangeCallback = onChange;
    onDeleteCallback = onDelete;
    onScopeChangeCallback = onScopeChange;

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

    initFilterRow();
}

/**
 * Apply backend capability flags to the panel. Called by the main entry
 * point right after a Connect, before the first poll fires. Hides UI
 * affordances the connected backend doesn't support and resets the
 * corresponding filter state so a stale toggle from a prior session
 * doesn't leak through.
 */
export function setCapabilities({ optimizeQuery }) {
    const optimizeWrapper =
        $("ltm-optimize")?.closest("label, .ltm-optimize-wrapper") ??
        $("ltm-optimize");
    if (optimizeWrapper) optimizeWrapper.hidden = !optimizeQuery;
    if (!optimizeQuery) {
        const checkbox = $("ltm-optimize");
        if (checkbox) checkbox.checked = false;
        filter.optimizeQuery = false;
    }
}

/**
 * Feed the discovered users/namespaces + current picks into the user and
 * namespace dropdowns of the filter row.
 */
export function setScopeOptions(options) {
    scopeOptions = { ...scopeOptions, ...options };
    repaintScopeSelects();
}

/**
 * Feed the session list (from `client.sessions.list`) into the
 * session multi-select. Selections that no longer exist are dropped from
 * the filter so a deleted session can't silently pin the view to nothing.
 */
export function setSessions(sessions) {
    knownSessions = sessions ?? [];
    const before = filter.sessionIds.length;
    filter.sessionIds = filter.sessionIds.filter((id) =>
        knownSessions.includes(id),
    );
    repaintDropdowns();
    if (filter.sessionIds.length !== before) onChangeCallback?.();
}

// ---------- filter row ----------

/**
 * Build the toolbar's filter row: user + namespace single-selects, then
 * one multi-select dropdown per server-side tag filter.
 */
function initFilterRow() {
    const row = $("ltm-filter-row");

    row.appendChild(buildScopeSelect("user"));
    row.appendChild(buildScopeSelect("ns"));

    row.appendChild(
        buildMultiSelect({
            key: "sessions",
            label: "sessions",
            getOptions: () => knownSessions,
            selected: () => filter.sessionIds,
            onToggle: toggleSessionFilter,
            emptyText: "no sessions",
        }),
    );
    row.appendChild(
        buildMultiSelect({
            key: "type",
            label: "type",
            getOptions: () => MEMORY_TYPES,
            selected: () => filter.memoryTypes,
            onToggle: (value) => toggleListFilter("memoryTypes", value),
        }),
    );
    row.appendChild(
        buildMultiSelect({
            key: "topics",
            label: "topics",
            getOptions: () =>
                [...new Set([...seenTopics, ...filter.topics])].sort(),
            selected: () => filter.topics,
            onToggle: (value) => toggleListFilter("topics", value),
            emptyText: "no topics seen yet",
        }),
    );
    row.appendChild(
        buildMultiSelect({
            key: "entities",
            label: "entities",
            getOptions: () =>
                [...new Set([...seenEntities, ...filter.entities])].sort(),
            selected: () => filter.entities,
            onToggle: (value) => toggleListFilter("entities", value),
            emptyText: "no entities seen yet",
        }),
    );

    // One shared close handler: click outside or Escape closes any open
    // popover.
    document.addEventListener("click", (event) => {
        if (event.target.closest(".filter-dropdown")) return;
        closeAllDropdowns();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAllDropdowns();
    });
}

/**
 * Pill-styled native <select> for the shared user / namespace scope.
 * Options come from setScopeOptions(); picking routes through
 * onScopeChange so the whole app (Overview pills included) follows.
 */
function buildScopeSelect(key) {
    const wrapper = document.createElement("label");
    wrapper.className = "filter-scope";
    wrapper.dataset.scopeKey = key;
    const caption = document.createElement("span");
    caption.textContent = key;
    const select = document.createElement("select");
    select.className = "filter-scope-select";
    select.setAttribute("aria-label", key === "ns" ? "namespace" : "user");
    select.addEventListener("change", () => {
        const value = select.value === "" ? null : select.value;
        onScopeChangeCallback?.(
            key === "ns" ? { namespace: value } : { userId: value },
        );
    });
    wrapper.appendChild(caption);
    wrapper.appendChild(select);
    return wrapper;
}

function repaintScopeSelects() {
    for (const wrapper of document.querySelectorAll(".filter-scope")) {
        const key = wrapper.dataset.scopeKey;
        if (key === "ns") wrapper.hidden = !scopeOptions.supportsNamespaces;
        const select = wrapper.querySelector("select");
        const current =
            key === "ns" ? scopeOptions.namespace : scopeOptions.userId;
        const options =
            key === "ns" ? scopeOptions.namespaces : scopeOptions.users;
        select.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "(none)";
        none.selected = current === null;
        select.appendChild(none);
        for (const value of options) {
            const opt = document.createElement("option");
            opt.value = value;
            opt.textContent = value;
            opt.selected = value === current;
            select.appendChild(opt);
        }
    }
}

/**
 * Generic checkbox-list dropdown ("label (n) ▾" button + popover). The
 * option list and selection are read through callbacks so a repaint
 * always reflects live state.
 */
function buildMultiSelect({
    key,
    label,
    getOptions,
    selected,
    onToggle,
    emptyText,
}) {
    const root = document.createElement("div");
    root.className = "filter-dropdown";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-dropdown-button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");

    const popover = document.createElement("div");
    popover.className = "filter-dropdown-popover";
    popover.hidden = true;

    const list = document.createElement("ul");
    list.className = "filter-dropdown-list";
    list.setAttribute("role", "list");
    popover.appendChild(list);

    button.addEventListener("click", () => {
        const open = popover.hidden;
        closeAllDropdowns();
        popover.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    });

    root.appendChild(button);
    root.appendChild(popover);

    const instance = {
        root,
        button,
        popover,
        list,
        label,
        getOptions,
        selected,
        onToggle,
        emptyText,
    };
    dropdowns.set(key, instance);
    repaintDropdown(instance);
    return root;
}

function repaintDropdown(instance) {
    const { button, list, label, getOptions, selected, onToggle, emptyText } =
        instance;
    const picked = selected();
    button.textContent = picked.length
        ? `${label} (${picked.length}) ▾`
        : `${label} ▾`;

    list.innerHTML = "";
    const options = getOptions();
    if (options.length === 0) {
        const li = document.createElement("li");
        li.className = "filter-dropdown-empty";
        li.textContent = emptyText ?? "no options";
        list.appendChild(li);
        return;
    }
    for (const value of options) {
        const li = document.createElement("li");
        const item = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = picked.includes(value);
        checkbox.addEventListener("change", () => onToggle(value));
        const text = document.createElement("span");
        text.textContent = value;
        item.appendChild(checkbox);
        item.appendChild(text);
        li.appendChild(item);
        list.appendChild(li);
    }
}

function repaintDropdowns() {
    for (const instance of dropdowns.values()) repaintDropdown(instance);
}

function closeAllDropdowns() {
    for (const { button, popover } of dropdowns.values()) {
        popover.hidden = true;
        button.setAttribute("aria-expanded", "false");
    }
}

// ---------- filter state mutations ----------

function toggleSessionFilter(sessionId) {
    const i = filter.sessionIds.indexOf(sessionId);
    if (i >= 0) filter.sessionIds.splice(i, 1);
    else filter.sessionIds.push(sessionId);
    seenIds.clear();
    repaintDropdowns();
    onChangeCallback?.();
}

/** Toggle a value in filter.topics / filter.entities / filter.memoryTypes. */
function toggleListFilter(bucket, value) {
    const list = filter[bucket];
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
    else list.push(value);
    repaintDropdowns();
    onChangeCallback?.();
}

function clearAllFilters() {
    filter.text = "";
    filter.topics = [];
    filter.entities = [];
    filter.sessionIds = [];
    filter.memoryTypes = [];
    $("ltm-search").value = "";
    repaintDropdowns();
    onChangeCallback?.();
}

// ---------- rendering ----------

/**
 * Records list (Long-term memory tab): full cards with every control.
 * `hasText` gates the similarity score - the server returns a meaningless
 * 0 distance on unranked (no-text) listings, so a score badge there would
 * read "0.000" on every card.
 */
export function renderRecords(memories) {
    $("longterm-stats").textContent = pluralize(memories.length, "result");

    // Grow the topic/entity option pools from whatever the current result
    // set shows.
    let sawNewValues = false;
    for (const memory of memories) {
        for (const topic of memory.topics ?? []) {
            if (!seenTopics.has(topic)) sawNewValues = true;
            seenTopics.add(topic);
        }
        for (const entity of memory.entities ?? []) {
            if (!seenEntities.has(entity)) sawNewValues = true;
            seenEntities.add(entity);
        }
    }
    if (sawNewValues) repaintDropdowns();

    // Sort chronologically (oldest first) so the long-term pane scrolls the
    // same direction as working memory - new memories appear at the bottom.
    // Redis Agent Memory's default order isn't chronological (it's relevance-ranked when
    // there's a text query, and otherwise implementation-defined). Sorting
    // client-side gives consistent UX in all modes.
    const sorted = [...memories].sort((a, b) => {
        const ta = new Date(a.created_at ?? 0).getTime();
        const tb = new Date(b.created_at ?? 0).getTime();
        return ta - tb;
    });

    const hasText = !!filter.text;
    const list = $("longterm-list");
    list.innerHTML = "";
    for (const memory of sorted) {
        list.appendChild(buildCard(memory, hasText));
    }
    if (!sorted.length) {
        const li = document.createElement("li");
        li.className = "summary-empty";
        li.textContent = "No long-term memories found for the current filters.";
        list.appendChild(li);
    }

    renderActiveFilters();
}

/**
 * Compact list for the Overview tab: newest first, badge + time + text
 * only, scoped by the caller to the picked session. Also stamps the
 * latest-extraction time into the pane header.
 */
export function renderOverview(memories) {
    $("browse-longterm-stats").textContent = pluralize(
        memories.length,
        "record",
    );

    const newestFirst = [...memories].sort(
        (a, b) =>
            new Date(b.created_at ?? 0).getTime() -
            new Date(a.created_at ?? 0).getTime(),
    );

    const latest = $("overview-latest");
    const newest = newestFirst[0]?.created_at;
    if (newest) {
        latest.hidden = false;
        latest.dateTime = newest;
        latest.textContent = formatDateTime(newest);
        latest.title = `latest extraction ${relativeTime(newest)}`;
    } else {
        latest.hidden = true;
    }

    const list = $("browse-longterm-list");
    list.innerHTML = "";
    for (const memory of newestFirst) {
        const node = fromTemplate("browse-card-template");

        const memoryType = memory.memory_type ?? "semantic";
        const typeEl = node.querySelector(".type-badge");
        typeEl.classList.add(`type-${memoryType}`);
        typeEl.textContent = memoryType;

        if (memory.created_at) {
            const when = node.querySelector("time");
            when.hidden = false;
            when.dateTime = memory.created_at;
            when.textContent = formatDateTime(memory.created_at);
            when.title = relativeTime(memory.created_at);
        }

        const textEl = node.querySelector(".card-text");
        textEl.textContent = memory.text ?? "";
        wireClampToggle(
            node.querySelector(".card-compact"),
            textEl,
            node.querySelector(".card-toggle"),
            !!memory.text,
        );
        list.appendChild(node);
    }
    if (!newestFirst.length) {
        const li = document.createElement("li");
        li.className = "summary-empty";
        li.textContent = "No long-term memories for the selected scope yet.";
        list.appendChild(li);
    }
}

/**
 * Clone the longterm-card template and fill its slots from a single
 * memory record. The template's structure (meta row, type badge,
 * timestamp, session, id, score, delete button, body text) is in
 * inspector.html; this function only handles data binding + visibility +
 * the delete handler that needs the memory.id closure.
 */
function buildCard(memory, hasText) {
    const node = fromTemplate("longterm-card-template");

    const isNew = memory.id && !seenIds.has(memory.id);
    if (memory.id) seenIds.add(memory.id);

    const card = node.querySelector(".card");
    if (isNew) card.classList.add("is-new");

    const memoryType = memory.memory_type ?? "semantic";
    const typeEl = node.querySelector(".type-badge");
    typeEl.classList.add(`type-${memoryType}`);
    typeEl.textContent = memoryType;

    if (memory.created_at) {
        const when = node.querySelector(".card-meta time");
        when.hidden = false;
        when.dateTime = memory.created_at;
        when.textContent = formatDateTime(memory.created_at);
        when.title = relativeTime(memory.created_at);
    }

    // Key name / id - copy icon sits to the LEFT of the shortened id and
    // reveals on hover. Full key still in the title.
    if (memory.id) {
        const idElement = node.querySelector(".card-id");
        idElement.hidden = false;
        const fullKey = memory.key ?? String(memory.id);
        idElement.querySelector(".card-id-copy").replaceWith(
            makeCopyButton(fullKey, "Copy key name"),
        );
        const text = idElement.querySelector(".card-id-text");
        text.textContent = shortId(memory.id);
        text.title = `Key Name: ${fullKey}`;
    }

    // Score only when the server actually ranked this result (a text query
    // was set) - an unranked listing reports 0 distance, which would badge
    // every card "0.000".
    if (hasText && typeof memory.score === "number") {
        const score = node.querySelector(".score-badge");
        score.hidden = false;
        score.textContent = memory.score.toFixed(3);
        score.title =
            `score: ${memory.score.toFixed(4)}\n` +
            `dist:  ${memory.dist?.toFixed?.(4) ?? "-"}\n` +
            `type:  ${memory.score_type ?? "-"}`;
    }

    node.querySelector(".card-text").textContent = memory.text ?? "";

    // Topics purple, entities grey - chip classes styled in inspector.css.
    const topicsRow = buildChipRow("topics", memory.topics, "chip-topic");
    if (topicsRow) node.querySelector(".card-text").after(topicsRow);
    const entitiesRow = buildChipRow("entities", memory.entities, "chip-entity");
    if (entitiesRow) {
        (topicsRow ?? node.querySelector(".card-text")).after(entitiesRow);
    }

    // Footer: source session (click to filter, copy on hover) + delete.
    if (memory.session_id) {
        const session = node.querySelector(".card-meta-session");
        session.hidden = false;
        const code = session.querySelector("code");
        code.textContent = memory.session_id;
        code.title = `Click to filter by this session: ${memory.session_id}`;
        code.classList.add("is-clickable");
        code.addEventListener("click", () => {
            if (!knownSessions.includes(memory.session_id)) {
                knownSessions.push(memory.session_id);
            }
            toggleSessionFilter(memory.session_id);
        });
        session
            .querySelector(".card-session-copy")
            .replaceWith(makeCopyButton(memory.session_id, "Copy session id"));
    }

    if (memory.id) {
        const del = node.querySelector(".card-delete-button");
        del.hidden = false;
        del.addEventListener("click", (event) => {
            event.stopPropagation();
            const snippet = (memory.text ?? "").slice(0, 100);
            const ok = confirm(
                `Delete this memory?\n\n"${snippet}${memory.text?.length > 100 ? "…" : ""}"`,
            );
            if (ok) onDeleteCallback?.(memory.id);
        });
    }

    return node;
}

/**
 * Labelled chip row - "topics: [chip1] [chip2] [chip3]". Returns `null`
 * for empty lists so the caller can skip appending instead of leaving a
 * dangling label. Labels mirror Redis Agent Memory's own field names so the UI matches
 * the record shape.
 */
function buildChipRow(label, values, chipClass) {
    if (!values || values.length === 0) return null;
    const row = fromTemplate("chip-row-template");
    row.querySelector(".chip-row-label").textContent = label;
    const chipsWrapper = row.querySelector(".chip-row-chips");
    for (const value of values) {
        const chip = fromTemplate("chip-template");
        chip.classList.add(chipClass);
        chip.textContent = value;
        chip.title = `Click to filter by this ${label.slice(0, -1)}`;
        chip.addEventListener("click", () => toggleListFilter(label, value));
        chipsWrapper.appendChild(chip);
    }
    return row;
}

/**
 * Removable pills above the card list reflecting the active filter set, so
 * it's always obvious what's narrowing the results. Sessions and types
 * appear here alongside topics/entities - one consistent "what's
 * filtering my view" surface.
 */
function renderActiveFilters() {
    const container = $("ltm-active-filters");
    container.innerHTML = "";

    const append = (key, value, onRemove) => {
        const pill = fromTemplate("filter-pill-template");
        pill.querySelector(".filter-pill-key").textContent = key;
        pill.querySelector(".filter-pill-value").textContent = value;
        pill.querySelector(".filter-pill-remove").addEventListener(
            "click",
            onRemove,
        );
        container.appendChild(pill);
    };

    for (const sessionId of filter.sessionIds) {
        const short =
            sessionId.length > 16
                ? `${sessionId.slice(0, 6)}…${sessionId.slice(-6)}`
                : sessionId;
        append("session", short, () => toggleSessionFilter(sessionId));
    }
    for (const memoryType of filter.memoryTypes) {
        append("type", memoryType, () =>
            toggleListFilter("memoryTypes", memoryType),
        );
    }
    for (const topic of filter.topics) {
        append("topic", topic, () => toggleListFilter("topics", topic));
    }
    for (const entity of filter.entities) {
        append("entity", entity, () => toggleListFilter("entities", entity));
    }

    if (
        filter.topics.length ||
        filter.entities.length ||
        filter.sessionIds.length ||
        filter.memoryTypes.length
    ) {
        // "Clear all" button - same chrome as the per-filter pills'
        // remove button, but standalone (no surrounding pill). Reuse the
        // filter-pill-remove class so it picks up the same hover styling.
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "filter-pill-remove filter-pill-clear-all";
        clear.textContent = "clear all";
        clear.title = "Remove all filters";
        clear.addEventListener("click", clearAllFilters);
        container.appendChild(clear);
    }
}
