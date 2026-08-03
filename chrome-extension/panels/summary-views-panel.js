/**
 * Summary-views pane (right side of the Long-term memory tab).
 *
 * Views are first-class: one collapsible <details> section per view,
 * titled by what it groups on ("By User ID"), with the stored name in a
 * badge revealing the view id. Each section lists its partition cards -
 * one LLM-computed profile each. A view with no partitions yet gets a
 * generate control; every view can be deleted.
 *
 * The caller owns fetching and the mutation calls (create defaults, run
 * view, run partition, delete view); this module renders and wires
 * controls.
 */

import { $, fromTemplate, makeCopyButton, wireClampToggle } from "../lib/dom.js";
import { formatDateTime, pluralize, relativeTime } from "../lib/format.js";
import { missingDefaultGroupings } from "../lib/summary-views.js";

let callbacks = {};
// Preserve which sections the user collapsed across re-renders (keyed by
// view id) so a refresh doesn't re-open everything.
const collapsed = new Set();
// View ids with a run in flight - their generate control stays disabled.
const running = new Set();

export function init(handlers) {
    callbacks = handlers;
    $("summary-create-defaults").addEventListener("click", () =>
        callbacks.onCreateDefaults?.(),
    );
}

/**
 * Backends without summary views (Cloud) or older servers that 404 hide
 * the pane entirely and let the records pane take the full width.
 */
export function setAvailable(available) {
    $("summary-pane").hidden = !available;
    $("view-ltm").classList.toggle("inspector-view-single", !available);
}

export function reset() {
    $("summary-views-list").innerHTML = "";
    $("summary-create-defaults").hidden = true;
}

export function setRunning(viewId, isRunning) {
    if (isRunning) running.add(viewId);
    else running.delete(viewId);
}

const groupKeyLabel = (key) =>
    key
        .split("_")
        .map((word) =>
            word === "id" ? "ID" : word[0].toUpperCase() + word.slice(1),
        )
        .join(" ");

/** Titled by what the view groups on; the stored name is just a label. */
const viewDisplayName = (view) =>
    view.group_by?.length
        ? `By ${view.group_by.map(groupKeyLabel).join(", ")}`
        : view.name;

/**
 * Repaint the whole pane.
 *   views       → SummaryView[] ({ id, name, group_by })
 *   partitions  → Record<viewId, partition[]>
 */
export function render({ views, partitions }) {
    $("summary-create-defaults").hidden =
        !views.length || missingDefaultGroupings(views).length === 0;

    const list = $("summary-views-list");
    list.innerHTML = "";

    if (!views.length) {
        const empty = fromTemplate("summary-empty-template");
        empty
            .querySelector(".summary-empty-create")
            .addEventListener("click", () => callbacks.onCreateDefaults?.());
        list.appendChild(empty);
        return;
    }

    for (const view of views) {
        list.appendChild(buildSection(view, partitions[view.id] ?? []));
    }
}

function buildSection(view, partitions) {
    const node = fromTemplate("summary-section-template");
    const details = node; // the <details> element itself
    details.open = !collapsed.has(view.id);

    const displayName = viewDisplayName(view);
    const groupTitle = view.group_by.map(groupKeyLabel).join(", ");
    const cardLabel = view.group_by
        .map((key) => key.replace(/_id$/, ""))
        .join(" · ");

    // Newest first - the freshest conversations are the ones being debugged.
    const ordered = [...partitions].sort(
        (a, b) =>
            new Date(b.computed_at ?? 0).getTime() -
            new Date(a.computed_at ?? 0).getTime(),
    );

    const summary = node.querySelector(".summary-view-summary");
    summary.addEventListener("click", (event) => {
        // Controls live outside <summary>; toggling is driven here so the
        // open state stays in sync with our `collapsed` set.
        event.preventDefault();
        details.open = !details.open;
        if (details.open) collapsed.delete(view.id);
        else collapsed.add(view.id);
        node.querySelector(".summary-view-chevron").textContent = details.open
            ? "▾"
            : "▸";
    });
    node.querySelector(".summary-view-chevron").textContent = details.open
        ? "▾"
        : "▸";
    node.querySelector(".summary-view-name").textContent = displayName;
    node.querySelector(".summary-view-count").textContent = pluralize(
        ordered.length,
        "summary",
        "summaries",
    );

    const badge = node.querySelector(".summary-view-badge");
    badge.textContent = view.name;
    badge.title = `View Id: ${view.id}`;

    // Generate is only meaningful before any partition exists (bootstrap);
    // per-partition recompute handles the rest.
    const generate = node.querySelector(".summary-view-generate");
    if (ordered.length) {
        generate.hidden = true;
    } else {
        generate.disabled = running.has(view.id);
        generate.addEventListener("click", () =>
            callbacks.onRunView?.(view.id),
        );
    }

    node.querySelector(".summary-view-delete").addEventListener("click", () => {
        const ok = confirm(
            `Delete summary view "${displayName}"?\n\nIt will stop being computed and listed. Already-computed summaries remain stored on the server.`,
        );
        if (ok) callbacks.onDeleteView?.(view.id);
    });

    const cardList = node.querySelector(".summary-card-list");
    if (!ordered.length) {
        const li = document.createElement("li");
        li.className = "summary-empty";
        li.textContent = "No summaries yet. Click ↻ above to compute them.";
        cardList.appendChild(li);
    } else {
        for (const partition of ordered) {
            cardList.appendChild(
                buildCard({
                    label: cardLabel,
                    groupTitle,
                    groupValue: Object.values(partition.group ?? {}).join(" · "),
                    group: partition.group ?? {},
                    partition,
                    viewId: view.id,
                }),
            );
        }
    }

    return node;
}

function buildCard({ label, groupTitle, groupValue, group, partition, viewId }) {
    const node = fromTemplate("summary-card-template");
    const card = node.querySelector(".summary-card");

    node.querySelector(".summary-scope-badge").textContent = label;

    const time = node.querySelector("time");
    if (partition.computed_at) {
        time.hidden = false;
        time.dateTime = partition.computed_at;
        time.textContent = formatDateTime(partition.computed_at);
        time.title = `computed ${relativeTime(partition.computed_at)}`;
    }

    const count = partition.memory_count;
    node.querySelector(".summary-card-count").textContent =
        typeof count === "number"
            ? `from ${pluralize(count, "memory", "memories")}`
            : "";

    const textEl = node.querySelector(".summary-banner-text");
    if (partition.summary) {
        textEl.textContent = partition.summary;
    } else {
        card.classList.add("is-empty");
        textEl.textContent = "No summary yet. Click ↻ to generate one.";
    }

    const toggle = node.querySelector(".summary-banner-toggle");
    wireClampToggle(card, textEl, toggle, !!partition.summary);

    // Footer: group id (with copy) + per-partition recompute.
    const groupEl = node.querySelector(".summary-group");
    if (groupValue) {
        groupEl.hidden = false;
        groupEl.textContent = groupValue;
        groupEl.title = `${groupTitle}: ${groupValue}`;
        node.querySelector(".summary-group-copy").replaceWith(
            makeCopyButton(groupValue, `Copy ${groupTitle}`),
        );
    }

    const refresh = node.querySelector(".summary-banner-refresh");
    refresh.setAttribute("aria-label", `Recompute ${label} summary`);
    refresh.addEventListener("click", () =>
        callbacks.onRunPartition?.(viewId, group, refresh),
    );

    return node;
}
