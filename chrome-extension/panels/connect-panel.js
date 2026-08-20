/**
 * Connect panel - the Redis Agent Memory-URL / namespace / refresh-cadence form shown when
 * the inspector window opens. Probes Redis Agent Memory's health and lists discoverable
 * namespaces so the dropdown autofills from real data.
 *
 * User + session selection happens in the inspector view after connect (see
 * the picker pills in inspector.js). The connect panel deliberately doesn't
 * surface those - they're a "which slice of the data am I looking at" choice,
 * not a "how do I reach the server" choice.
 *
 * The panel doesn't own the config - it gathers values and hands them to the
 * caller via `onConnect(config)` once the user clicks Connect. The caller
 * (inspector.js) decides what to do with that config.
 */

import { $ } from "../lib/dom.js";
import { createAgentMemoryClient } from "../lib/agent-memory-client.js";
import {
    loadAll as loadSavedConnections,
    getLastUsed as getLastUsedConnection,
    save as saveConnection,
    remove as forgetConnection,
} from "../lib/saved-connections.js";

/** Selected backend from the radio group ("cloud" | "self-managed"). */
function selectedBackend() {
    const checked = document.querySelector(
        'input[name="config-backend"]:checked',
    );
    return checked?.value ?? "cloud";
}

/**
 * Backend-aware accessors for the URL input + its health badge. The form
 * has one URL field per backend, shown/hidden via `applyBackendVisibility`.
 * Everything else in this file just asks "give me the active one" so we
 * don't sprinkle backend checks everywhere.
 */
function activeUrlInput() {
    return selectedBackend() === "self-managed"
        ? $("config-url-selfmanaged")
        : $("config-url-cloud");
}
function activeHealthBadge() {
    return selectedBackend() === "self-managed"
        ? $("url-health-selfmanaged")
        : $("url-health-cloud");
}

/** Self-managed auth from the selector + credential field. */
function readSelfManagedAuth() {
    const method = $("config-auth-selfmanaged").value;
    const credential = $("config-credential-selfmanaged").value.trim();
    return { method, credential: credential || undefined };
}

/**
 * Build a temporary client for connect-time probes (health, discovery).
 * The user hasn't committed yet, so we don't store this - we build a fresh
 * one per probe against whatever's currently in the form.
 *
 * For cloud, we need all three of url + apiKey + storeId before a probe is
 * even meaningful; return null until they're all set so the URL-debounced
 * probe doesn't fire half-configured requests.
 */
function probeClient() {
    const url = activeUrlInput().value.trim().replace(/\/+$/, "");
    if (!url) return null;
    const backend = selectedBackend();
    if (backend === "cloud") {
        const apiKey = $("config-api-key").value.trim();
        const storeId = $("config-store-id").value.trim();
        if (!apiKey || !storeId) return null;
        // Empty proxyUrl means "use the built-in default" - let the client
        // decide. Trim trailing slashes to keep URL building consistent.
        const proxyUrl =
            $("config-proxy-url").value.trim().replace(/\/+$/, "") || null;
        return createAgentMemoryClient({
            backend,
            url,
            apiKey,
            storeId,
            proxyUrl,
        });
    }
    if (backend === "self-managed") {
        const storeId = $("config-store-id-selfmanaged").value.trim();
        if (!storeId) return null;
        return createAgentMemoryClient({
            backend,
            url,
            storeId,
            auth: readSelfManagedAuth(),
        });
    }
    return null;
}

const HEALTH_DEBOUNCE_MS = 1000;
let healthDebounce = null;
let onConnectCallback = null;
let savedConnectionsListenersBound = false;

function setStatus(s) {
    $("status-line").textContent = s;
}

/**
 * Show the panel and wire its inputs. `seed` pre-fills fields (e.g. on
 * Reconfigure, we pass the current config so the user doesn't have to re-type).
 */
export function show({ seed = {}, onConnect }) {
    onConnectCallback = onConnect;

    // Connect panel lives in its own page (config.html) now - no
    // sibling inspector view to hide on the same DOM. The other
    // header/connection-pill elements only exist on inspector.html.

    // Pre-fill fields from the seed; pre-select the backend radio according
    // to the seed. A seed without an explicit backend defaults to Cloud.
    if (seed.backend === "self-managed") {
        document.querySelector(
            'input[name="config-backend"][value="self-managed"]',
        ).checked = true;
        if (seed.url) $("config-url-selfmanaged").value = seed.url;
    } else {
        // Cloud is the default backend.
        document.querySelector(
            'input[name="config-backend"][value="cloud"]',
        ).checked = true;
        if (seed.url) $("config-url-cloud").value = seed.url;
    }
    if (seed.apiKey) $("config-api-key").value = seed.apiKey;
    if (seed.storeId) {
        $("config-store-id").value = seed.storeId;
        $("config-store-id-selfmanaged").value = seed.storeId;
    }
    if (seed.proxyUrl) $("config-proxy-url").value = seed.proxyUrl;
    if (seed.auth) {
        $("config-auth-selfmanaged").value = seed.auth.method ?? "none";
        $("config-credential-selfmanaged").value = seed.auth.credential ?? "";
    }
    applyBackendVisibility();

    // Bind URL/credential listeners on each backend's URL input up front -
    // whichever is visible is the one the user is editing - so we don't have
    // to rebind when the backend radio flips.
    $("config-url-cloud").addEventListener("input", onUrlInput);
    $("config-url-cloud").addEventListener("focus", (e) => e.target.select());

    // Switching backend changes which fields are required + may need a
    // re-probe of the new URL/credentials. Also wipe both health badges
    // so a stale ✓ live doesn't carry over from the previous backend.
    for (const radio of document.querySelectorAll(
        'input[name="config-backend"]',
    )) {
        radio.addEventListener("change", () => {
            applyBackendVisibility();
            clearHealthBadges();
            // Saved-connections dropdown is scoped to the active
            // backend; re-render so the options reflect the new choice.
            renderSavedConnections().catch((err) =>
                console.warn("[connect-panel] saved-connections re-render failed:", err.message),
            );
            updateConnectButton();
            runDiscovery();
        });
    }

    // Re-probe when cloud credentials change (debounced via the URL input
    // path) - these are required before any probe is meaningful. The proxy
    // URL also triggers a re-probe because changing it changes where the
    // request actually goes.
    $("config-api-key").addEventListener("input", onUrlInput);
    $("config-store-id").addEventListener("input", onUrlInput);
    $("config-proxy-url").addEventListener("input", onUrlInput);

    // Self-managed inputs re-probe on change; the auth selector also toggles
    // the credential field's visibility.
    $("config-url-selfmanaged").addEventListener("input", onUrlInput);
    $("config-url-selfmanaged").addEventListener("focus", (e) =>
        e.target.select(),
    );
    $("config-store-id-selfmanaged").addEventListener("input", onUrlInput);
    $("config-credential-selfmanaged").addEventListener("input", onUrlInput);
    $("config-auth-selfmanaged").addEventListener("change", () => {
        applyBackendVisibility();
        onUrlInput();
    });

    // Form submit (Enter on any input OR Connect button click) drives the
    // connect flow. preventDefault stops the browser from doing a real
    // GET navigation; we hand off to the parent via onConnect instead.
    $("connect-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const config = readFormConfig();
        // Persist before handing off so the next window-open auto-picks
        // this connection. Fire-and-forget; storage failures shouldn't
        // block connect.
        saveConnection(config).catch((err) =>
            console.warn("[connect-panel] save failed:", err.message),
        );
        onConnectCallback?.(config);
    });

    // If we weren't given an explicit seed (i.e. fresh window open, not
    // a Reconfigure), fall back to the last-used entry from
    // chrome.storage.session so the user just sees the form pre-filled
    // and can hit Connect. Hydrate first (which may flip the backend
    // radio), then render saved connections so the dropdown reflects
    // the active backend, then probe.
    if (!seed?.url) {
        getLastUsedConnection().then((last) => {
            if (last) hydrateForm(last);
            renderSavedConnections().catch((err) =>
                console.warn("[connect-panel] render saved failed:", err.message),
            );
            runDiscovery(last ?? seed);
        });
    } else {
        renderSavedConnections().catch((err) =>
            console.warn("[connect-panel] render saved failed:", err.message),
        );
        runDiscovery(seed);
    }
}

/**
 * Populate every connect-form field from a stored connection. Mirrors
 * the seed-handling in `show()` but in one place so loading from
 * saved-connections doesn't drift from the Reconfigure path.
 */
function hydrateForm(config) {
    if (config.backend === "self-managed") {
        document.querySelector(
            'input[name="config-backend"][value="self-managed"]',
        ).checked = true;
        $("config-url-selfmanaged").value = config.url ?? "";
        $("config-store-id-selfmanaged").value = config.storeId ?? "";
        $("config-auth-selfmanaged").value = config.auth?.method ?? "none";
        $("config-credential-selfmanaged").value = config.auth?.credential ?? "";
    } else {
        // Cloud is the default backend.
        document.querySelector(
            'input[name="config-backend"][value="cloud"]',
        ).checked = true;
        $("config-url-cloud").value = config.url ?? "";
        $("config-api-key").value = config.apiKey ?? "";
        $("config-store-id").value = config.storeId ?? "";
        $("config-proxy-url").value = config.proxyUrl ?? "";
    }
    applyBackendVisibility();
    updateConnectButton();
}

/**
 * Render the saved-connections dropdown at the top of the connect panel.
 * Native <select> with one <option> per saved entry; the last-used entry
 * is pre-selected. The × button next to the dropdown forgets whichever
 * entry is currently selected.
 *
 * Listeners are bound once (idempotent via a flag on the elements
 * themselves) so re-renders after add/forget don't duplicate them.
 */
async function renderSavedConnections() {
    const wrap = $("saved-connections");
    const select = $("saved-connections-select");
    const forgetButton = $("saved-connections-forget");
    if (!wrap || !select || !forgetButton) return;

    // Show only entries that match the currently-picked backend - the
    // dropdown lives below the Backend radio, so its contents are scoped
    // to the active choice. Flipping the radio re-renders us.
    const backend = selectedBackend();
    const allEntries = await loadSavedConnections();
    const entries = allEntries.filter((e) => e.backend === backend);
    if (entries.length === 0) {
        wrap.hidden = true;
        select.innerHTML = "";
        return;
    }

    const lastUsed = await getLastUsedConnection();
    const preselect = lastUsed && lastUsed.backend === backend ? lastUsed.id : null;
    select.innerHTML = "";
    for (const entry of entries) {
        const opt = document.createElement("option");
        opt.value = entry.id;
        opt.textContent = entry.alias;
        if (preselect === entry.id) opt.selected = true;
        select.appendChild(opt);
    }

    // Bind listeners exactly once. The <select> and × button are the
    // same DOM nodes across every renderSavedConnections() call - we
    // only refill the <option>s - so re-binding on every call would
    // stack duplicate handlers and fire the callback N times per click.
    if (!savedConnectionsListenersBound) {
        savedConnectionsListenersBound = true;
        select.addEventListener("change", async () => {
            const entry = (await loadSavedConnections()).find(
                (e) => e.id === select.value,
            );
            if (entry) {
                hydrateForm(entry);
                runDiscovery(entry);
            }
        });
        forgetButton.addEventListener("click", async () => {
            const id = select.value;
            if (!id) return;
            await forgetConnection(id);
            renderSavedConnections();
        });
    }

    wrap.hidden = false;
}

function readFormConfig() {
    const backend = selectedBackend();
    const config = {
        backend,
        url: activeUrlInput().value.trim().replace(/\/+$/, ""),
        // userId + sessionId are picked in the inspector view (header
        // pills), not here. Left null until the auto-pick runs.
        userId: null,
        sessionId: null,
        // Namespace is picked in the inspector view (header pill), not here.
        // Left null until autoPickFilters runs.
        namespace: null,
    };
    if (backend === "cloud") {
        config.apiKey = $("config-api-key").value.trim();
        config.storeId = $("config-store-id").value.trim();
        // Empty string → null so the cloud client falls back to its
        // built-in default proxy URL.
        config.proxyUrl =
            $("config-proxy-url").value.trim().replace(/\/+$/, "") || null;
    } else if (backend === "self-managed") {
        config.storeId = $("config-store-id-selfmanaged").value.trim();
        config.auth = readSelfManagedAuth();
    }
    return config;
}

function isCompleteConfig(config) {
    // Only the connection bits matter here. user + session are
    // resolved after connect via the picker pills.
    if (!config?.url) return false;
    if (config.backend === "cloud") {
        if (!config.apiKey || !config.storeId) return false;
    }
    if (config.backend === "self-managed") {
        if (!config.storeId) return false;
    }
    return true;
}

/**
 * Toggle visibility of fields that only apply to a specific backend. Cloud
 * uses storeId + apiKey + proxy URL; self-managed uses storeId + auth.
 */
function applyBackendVisibility() {
    const backend = selectedBackend();
    const isCloud = backend === "cloud";
    const isSelfManaged = backend === "self-managed";
    $("field-url-cloud").hidden = !isCloud;
    $("field-store-id").hidden = !isCloud;
    $("field-api-key").hidden = !isCloud;
    $("field-proxy-url").hidden = !isCloud;
    $("field-url-selfmanaged").hidden = !isSelfManaged;
    $("field-store-id-selfmanaged").hidden = !isSelfManaged;
    $("field-auth-selfmanaged").hidden = !isSelfManaged;
    // Credential only applies when an auth mode other than None is picked.
    $("field-credential-selfmanaged").hidden =
        !isSelfManaged || $("config-auth-selfmanaged").value === "none";
}

function clearHealthBadges() {
    for (const id of ["url-health-cloud", "url-health-selfmanaged"]) {
        const el = $(id);
        if (!el) continue;
        el.textContent = "";
        el.className = "health-badge";
    }
}

function updateConnectButton() {
    $("connect-button").disabled = !isCompleteConfig(readFormConfig());
}

function onUrlInput() {
    clearTimeout(healthDebounce);
    clearHealthBadges();
    healthDebounce = setTimeout(() => runDiscovery(), HEALTH_DEBOUNCE_MS);
}

async function runDiscovery(_seed = null) {
    // The connect panel only verifies the server is reachable. Namespaces,
    // users, and sessions are discovered in the inspector view after connect
    // so they can be flipped from the header picker pills without
    // reconnecting.
    const probe = probeClient();
    if (!probe) return;

    const url = activeUrlInput().value.trim().replace(/\/+$/, "");
    setStatus(`Probing ${url}…`);
    const badge = activeHealthBadge();
    const health = await probe.health.ping();
    if (health.ok) {
        badge.textContent = "✓ live";
        badge.className = "health-badge is-live";
        updateConnectButton();
        setStatus("Ready.");
    } else {
        badge.textContent = health.status ? `✗ ${health.status}` : "✗ unreachable";
        badge.className = "health-badge is-dead";
        // Surface the cloud's structured error detail so the user sees the
        // actual reason (e.g. "Invalid API key", "Store not found"), not
        // just the status code.
        const why = health.detail ? `: ${health.detail}` : "";
        setStatus(`No response from ${url} (${health.status || "no response"})${why}`);
    }
}
