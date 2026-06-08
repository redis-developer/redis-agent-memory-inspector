/**
 * Connect panel - the AMS-URL / namespace / refresh-cadence form shown when
 * the inspector window opens. Probes AMS's health and lists discoverable
 * namespaces so the dropdown autofills from real data.
 *
 * User + session selection happens in the inspector view after connect (see
 * the picker pills in index.js). The connect panel deliberately doesn't
 * surface those - they're a "which slice of the data am I looking at" choice,
 * not a "how do I reach the server" choice.
 *
 * The panel doesn't own the config - it gathers values and hands them to the
 * caller via `onConnect(config)` once the user clicks Connect. The caller
 * (index.js) decides what to do with that config.
 */

import { $ } from "../lib/dom.js";
import { createAmsClient } from "../lib/ams-client.js";

/** Selected backend from the radio group ("oss" or "cloud"). */
function selectedBackend() {
    const checked = document.querySelector(
        'input[name="config-backend"]:checked',
    );
    return checked?.value ?? "oss";
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
    const url = $("config-url").value.trim().replace(/\/+$/, "");
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
        return createAmsClient({
            backend,
            url,
            apiKey,
            storeId,
            proxyUrl,
        });
    }
    return createAmsClient({ backend, url });
}

const HEALTH_DEBOUNCE_MS = 1000;
let healthDebounce = null;
let onConnectCallback = null;

function setStatus(s) {
    $("status-line").textContent = s;
}

/**
 * Show the panel and wire its inputs. `seed` pre-fills fields (e.g. on
 * Reconfigure, we pass the current config so the user doesn't have to re-type).
 */
export function show({ seed = {}, onConnect }) {
    onConnectCallback = onConnect;

    $("connect-panel").hidden = false;
    $("inspector-view").hidden = true;
    $("connection-pills").hidden = true;
    $("reconfigure-button").hidden = true;
    $("refresh-button").hidden = true;

    const urlInput = $("config-url");
    if (seed.url) urlInput.value = seed.url;
    urlInput.addEventListener("input", onUrlInput);

    // Pre-fill cloud-only fields if the seed has them; pre-select the
    // backend radio according to the seed (defaults to "oss").
    if (seed.backend === "cloud") {
        document.querySelector(
            'input[name="config-backend"][value="cloud"]',
        ).checked = true;
    }
    if (seed.apiKey) $("config-api-key").value = seed.apiKey;
    if (seed.storeId) $("config-store-id").value = seed.storeId;
    if (seed.proxyUrl) $("config-proxy-url").value = seed.proxyUrl;
    applyBackendVisibility();

    // Switching backend changes which fields are required + may need a
    // re-probe of the new URL/credentials. Also wipe the health badge so a
    // stale ✓ live doesn't carry over from the previous backend.
    for (const radio of document.querySelectorAll(
        'input[name="config-backend"]',
    )) {
        radio.addEventListener("change", () => {
            applyBackendVisibility();
            $("url-health").textContent = "";
            $("url-health").className = "health-badge";
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

    // Select-all on focus for the URL input. Without this, clicking into a
    // pre-filled field lands the cursor at the end and typing appends.
    $("config-url").addEventListener("focus", (e) => e.target.select());

    // Pre-fill refresh-interval inputs from seed config if it has them. The config
    // stores intervals in milliseconds; the inputs work in seconds because
    // that's the unit users think in.
    if (typeof seed.workingMemoryRefreshMs === "number") {
        $("config-working-refresh").value = Math.round(seed.workingMemoryRefreshMs / 1000);
    }
    if (typeof seed.longTermMemoryRefreshMs === "number") {
        $("config-longterm-refresh").value = Math.round(seed.longTermMemoryRefreshMs / 1000);
    }

    $("connect-button").addEventListener("click", () => {
        const config = readFormConfig();
        onConnectCallback?.(config);
    });

    // Kick off discovery immediately so the namespace dropdown populates from
    // the current URL.
    runDiscovery(seed);
}

function readFormConfig() {
    // Convert seconds → milliseconds. The inputs are typed in seconds (more
    // natural for the user); the rest of the app works in ms (matches
    // setInterval / setTimeout). Clamped to a sane minimum so a stray 0 or
    // negative value doesn't melt the browser.
    const workingSeconds = Math.max(1, parseInt($("config-working-refresh").value, 10) || 3);
    const longTermSeconds = Math.max(1, parseInt($("config-longterm-refresh").value, 10) || 5);

    const backend = selectedBackend();
    const config = {
        backend,
        url: $("config-url").value.trim().replace(/\/+$/, ""),
        // userId + sessionId are picked in the inspector view (header
        // pills), not here. Left null until the auto-pick runs.
        userId: null,
        sessionId: null,
        // Namespace is picked in the inspector view (header pill), not here.
        // Left null until autoPickFilters runs.
        namespace: null,
        workingMemoryRefreshMs: workingSeconds * 1000,
        longTermMemoryRefreshMs: longTermSeconds * 1000,
    };
    if (backend === "cloud") {
        config.apiKey = $("config-api-key").value.trim();
        config.storeId = $("config-store-id").value.trim();
        // Empty string → null so the cloud client falls back to its
        // built-in default proxy URL.
        config.proxyUrl =
            $("config-proxy-url").value.trim().replace(/\/+$/, "") || null;
    }
    return config;
}

function isCompleteConfig(config) {
    // Only the connection bits matter here. user_id + session_id are
    // resolved after connect via the picker pills.
    if (!config?.url) return false;
    if (config.backend === "cloud") {
        if (!config.apiKey || !config.storeId) return false;
    }
    return true;
}

/**
 * Toggle visibility of fields that only apply to a specific backend. Cloud
 * uses storeId + apiKey + proxy URL; OSS uses neither.
 */
function applyBackendVisibility() {
    const backend = selectedBackend();
    const isCloud = backend === "cloud";
    $("field-store-id").hidden = !isCloud;
    $("field-api-key").hidden = !isCloud;
    $("field-proxy-url").hidden = !isCloud;
}

function updateConnectButton() {
    $("connect-button").disabled = !isCompleteConfig(readFormConfig());
}

function onUrlInput() {
    clearTimeout(healthDebounce);
    $("url-health").textContent = "";
    $("url-health").className = "health-badge";
    healthDebounce = setTimeout(() => runDiscovery(), HEALTH_DEBOUNCE_MS);
}

async function runDiscovery(_seed = null) {
    // The connect panel only verifies the server is reachable. Namespaces,
    // users, and sessions are discovered in the inspector view after connect
    // so they can be flipped from the header picker pills without
    // reconnecting.
    const probe = probeClient();
    if (!probe) return;

    const url = $("config-url").value.trim().replace(/\/+$/, "");
    setStatus(`Probing ${url}…`);
    const badge = $("url-health");
    const health = await probe.pingHealth();
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
