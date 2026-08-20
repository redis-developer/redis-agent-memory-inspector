/**
 * Record details pane (Long-term memory tab) - shows every field the API
 * returns for the selected memory record. View-only for now; edit lands in
 * a later pass.
 */

import { $, fromTemplate } from "../lib/dom.js";
import { formatDateTime } from "../lib/format.js";

// Preferred display order; unknown keys follow in their original order.
const FIELD_ORDER = [
    "id",
    "text",
    "memoryType",
    "ownerId",
    "sessionId",
    "namespace",
    "topics",
    "attributes",
    "createdAt",
    "updatedAt",
];

const TIMESTAMP_KEYS = new Set(["createdAt", "updatedAt"]);

// Card-only fields with no meaning as a record detail.
const HIDDEN_KEYS = new Set(["key", "score", "dist", "score_type"]);

export function reset() {
    const fields = $("record-detail-fields");
    fields.innerHTML = "";
    fields.hidden = true;
    $("record-detail-empty").hidden = false;
}

export function render(record) {
    const fields = $("record-detail-fields");
    fields.innerHTML = "";

    const entries = Object.entries(record ?? {}).filter(
        ([key]) => !HIDDEN_KEYS.has(key),
    );
    entries.sort((a, b) => orderIndex(a[0]) - orderIndex(b[0]));

    for (const [key, value] of entries) {
        fields.appendChild(buildField(key, value));
    }

    const hasFields = entries.length > 0;
    fields.hidden = !hasFields;
    $("record-detail-empty").hidden = hasFields;
}

function orderIndex(key) {
    const i = FIELD_ORDER.indexOf(key);
    return i === -1 ? FIELD_ORDER.length : i;
}

function buildField(key, value) {
    const node = fromTemplate("record-field-template");
    node.querySelector(".record-field-label").textContent = humanize(key);
    formatValue(node.querySelector(".record-field-value"), key, value);
    return node;
}

/** "memoryType" -> "Memory Type". */
function humanize(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(el, key, value) {
    if (value === null || value === undefined || value === "") {
        el.textContent = "—";
        el.classList.add("is-empty");
        return;
    }
    if (Array.isArray(value)) {
        if (!value.length) {
            el.textContent = "—";
            el.classList.add("is-empty");
            return;
        }
        el.textContent = value.join(", ");
        return;
    }
    if (typeof value === "object") {
        const pre = document.createElement("pre");
        pre.className = "record-field-json";
        pre.textContent = JSON.stringify(value, null, 2);
        el.appendChild(pre);
        return;
    }
    if (TIMESTAMP_KEYS.has(key)) {
        el.textContent = formatDateTime(value);
        return;
    }
    el.textContent = String(value);
}
