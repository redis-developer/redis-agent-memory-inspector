/**
 * Connect panel - the AMS-URL / user / session form shown when the inspector
 * window opens. Probes AMS's health, derives users and namespaces from a
 * single long-term-memory scan, and lists sessions for the selected user
 * so the dropdowns autofill from real data.
 *
 * The panel doesn't own the cfg - it gathers values and hands them to the
 * caller via `onConnect(cfg)` once the user clicks Connect. The caller
 * (index.js) decides what to do with that cfg.
 */

import { $ } from "../lib/dom.js";
import { createAmsClient } from "../lib/ams-client.js";

/** Selected backend from the radio group ("oss" or "cloud"). */
function selectedBackend() {
    const checked = document.querySelector(
        'input[name="cfg-backend"]:checked',
    );
    return checked?.value ?? "oss";
}

/**
 * Build a temporary client for connect-time probes (health, discovery,
 * session listing). The user hasn't committed yet, so we don't store this -
 * we build a fresh one per probe against whatever's currently in the form.
 *
 * For cloud, we need all three of url + apiKey + storeId before a probe is
 * even meaningful; return null until they're all set so the URL-debounced
 * probe doesn't fire half-configured requests.
 */
function probeClient() {
    const url = $("cfg-url").value.trim().replace(/\/+$/, "");
    if (!url) return null;
    const backend = selectedBackend();
    if (backend === "cloud") {
        const apiKey = $("cfg-api-key").value.trim();
        const storeId = $("cfg-store-id").value.trim();
        if (!apiKey || !storeId) return null;
        // Empty proxyUrl means "use the built-in default" - let the client
        // decide. Trim trailing slashes to keep URL building consistent.
        const proxyUrl =
            $("cfg-proxy-url").value.trim().replace(/\/+$/, "") || null;
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
let userDebounce = null;
let onConnectCallback = null;

function setStatus(s) {
    $("status-line").textContent = s;
}

/**
 * Show the panel and wire its inputs. `seed` pre-fills fields (e.g. on
 * Reconfigure, we pass the current cfg so the user doesn't have to re-type).
 */
export function show({ seed = {}, onConnect }) {
    onConnectCallback = onConnect;

    $("connect-panel").hidden = false;
    $("inspector-view").hidden = true;
    $("connection-pills").hidden = true;
    $("reconfigure-btn").hidden = true;
    $("refresh-btn").hidden = true;

    const urlInput = $("cfg-url");
    if (seed.url) urlInput.value = seed.url;
    urlInput.addEventListener("input", onUrlInput);

    // Pre-fill cloud-only fields if the seed has them; pre-select the
    // backend radio according to the seed (defaults to "oss").
    if (seed.backend === "cloud") {
        document.querySelector(
            'input[name="cfg-backend"][value="cloud"]',
        ).checked = true;
    }
    if (seed.apiKey) $("cfg-api-key").value = seed.apiKey;
    if (seed.storeId) $("cfg-store-id").value = seed.storeId;
    if (seed.proxyUrl) $("cfg-proxy-url").value = seed.proxyUrl;
    applyBackendVisibility();

    // Switching backend changes which fields are required + may need a
    // re-probe of the new URL/credentials. Also wipe the health badge so a
    // stale ✓ live doesn't carry over from the previous backend.
    for (const radio of document.querySelectorAll(
        'input[name="cfg-backend"]',
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
    $("cfg-api-key").addEventListener("input", onUrlInput);
    $("cfg-store-id").addEventListener("input", onUrlInput);
    $("cfg-proxy-url").addEventListener("input", onUrlInput);

    // Select-all on focus for all text inputs in the connect panel. Without
    // this, clicking into a pre-filled field lands the cursor at the end and
    // typing appends (e.g. "ashwin" + typed "ashwin" → "ashwinashwin"). With
    // this, a single click highlights the value and the next keystroke
    // replaces it - standard combobox UX.
    for (const id of ["cfg-url", "cfg-user", "cfg-session"]) {
        $(id).addEventListener("focus", (e) => e.target.select());
    }

    // Pre-fill refresh-interval inputs from seed cfg if it has them. The cfg
    // stores intervals in milliseconds; the inputs work in seconds because
    // that's the unit users think in.
    if (typeof seed.workingMemoryRefreshMs === "number") {
        $("cfg-working-refresh").value = Math.round(seed.workingMemoryRefreshMs / 1000);
    }
    if (typeof seed.longTermMemoryRefreshMs === "number") {
        $("cfg-longterm-refresh").value = Math.round(seed.longTermMemoryRefreshMs / 1000);
    }

    // User input is a combobox (<input list> + <datalist>). We need both
    // `input` (typing) and `change` (datalist-pick) events. Debounce session
    // refresh so we don't refire on every keystroke.
    const userInput = $("cfg-user");
    const onUserChange = () => {
        clearTimeout(userDebounce);
        userDebounce = setTimeout(() => refreshSessionDropdown(), 250);
        updateConnectButton();
    };
    userInput.addEventListener("input", onUserChange);
    userInput.addEventListener("change", onUserChange);

    $("cfg-namespace").addEventListener("change", () => {
        // Namespace change only affects the session list (which filters by
        // namespace); user discovery returns all distinct users regardless.
        // Re-running full discovery here would also re-populate this very
        // dropdown and clobber the user's selection back to "(none)".
        refreshSessionDropdown();
        updateConnectButton();
    });

    const sessionInput = $("cfg-session");
    sessionInput.addEventListener("input", updateConnectButton);
    sessionInput.addEventListener("change", updateConnectButton);

    $("connect-btn").addEventListener("click", () => {
        const cfg = readFormCfg();
        onConnectCallback?.(cfg);
    });

    // Kick off discovery immediately so dropdowns populate from current URL.
    runDiscovery(seed);
}

function readFormCfg() {
    // Convert seconds → milliseconds. The inputs are typed in seconds (more
    // natural for the user); the rest of the app works in ms (matches
    // setInterval / setTimeout). Clamped to a sane minimum so a stray 0 or
    // negative value doesn't melt the browser.
    const workingSec = Math.max(1, parseInt($("cfg-working-refresh").value, 10) || 3);
    const longTermSec = Math.max(1, parseInt($("cfg-longterm-refresh").value, 10) || 5);

    const backend = selectedBackend();
    const cfg = {
        backend,
        url: $("cfg-url").value.trim().replace(/\/+$/, ""),
        userId: $("cfg-user").value.trim() || null,
        sessionId: $("cfg-session").value.trim() || null,
        namespace: $("cfg-namespace").value || null,
        workingMemoryRefreshMs: workingSec * 1000,
        longTermMemoryRefreshMs: longTermSec * 1000,
    };
    if (backend === "cloud") {
        cfg.apiKey = $("cfg-api-key").value.trim();
        cfg.storeId = $("cfg-store-id").value.trim();
        // Empty string → null so the cloud client falls back to its
        // built-in default proxy URL.
        cfg.proxyUrl =
            $("cfg-proxy-url").value.trim().replace(/\/+$/, "") || null;
    }
    return cfg;
}

function isCompleteCfg(cfg) {
    // userId is optional - some apps (e.g. redish) key by namespace+sessionId
    // and never set user_id. For cloud, the apiKey + storeId are required -
    // the request is unauthenticated without them and the path is malformed
    // without storeId.
    if (!cfg?.url || !cfg?.sessionId) return false;
    if (cfg.backend === "cloud") {
        if (!cfg.apiKey || !cfg.storeId) return false;
    }
    return true;
}

/**
 * Toggle visibility of fields that only apply to a specific backend. Cloud
 * uses storeId + apiKey; namespaces don't exist on cloud, so we hide that
 * field regardless of what discovery returned.
 */
function applyBackendVisibility() {
    const backend = selectedBackend();
    const isCloud = backend === "cloud";
    $("field-store-id").hidden = !isCloud;
    $("field-api-key").hidden = !isCloud;
    $("field-proxy-url").hidden = !isCloud;
    if (isCloud) {
        // Cloud has no namespace concept; force-hide.
        $("field-namespace").hidden = true;
    }
}

function updateConnectButton() {
    $("connect-btn").disabled = !isCompleteCfg(readFormCfg());
}

function onUrlInput() {
    clearTimeout(healthDebounce);
    $("url-health").textContent = "";
    $("url-health").className = "health-badge";
    healthDebounce = setTimeout(() => runDiscovery(), HEALTH_DEBOUNCE_MS);
}

async function runDiscovery(seed = null) {
    const probe = probeClient();
    if (!probe) return;

    const url = $("cfg-url").value.trim().replace(/\/+$/, "");
    setStatus(`Probing ${url}…`);
    const badge = $("url-health");
    const health = await probe.pingHealth();
    if (health.ok) {
        badge.textContent = "✓ live";
        badge.className = "health-badge is-live";
    } else {
        badge.textContent = health.status ? `✗ ${health.status}` : "✗ unreachable";
        badge.className = "health-badge is-dead";
        // Surface the cloud's structured error detail so the user sees the
        // actual reason (e.g. "Invalid API key", "Store not found"), not
        // just the status code.
        const why = health.detail ? `: ${health.detail}` : "";
        setStatus(`No response from ${url} (${health.status || "no response"})${why}`);
        return;
    }

    setStatus("Scanning memories to populate filters…");
    let discovered;
    try {
        discovered = await probe.discoverFilters();
    } catch (err) {
        setStatus(`Discovery failed: ${err.message}`);
        return;
    }

    populateSelect(
        $("cfg-namespace"),
        discovered.namespaces,
        seed?.namespace ?? null,
        { allowNone: true },
    );
    $("field-namespace").hidden = discovered.namespaces.length === 0;

    populateDatalist($("cfg-user-options"), discovered.users);
    if (seed?.userId) {
        $("cfg-user").value = seed.userId;
    } else if (discovered.users.length === 1) {
        $("cfg-user").value = discovered.users[0];
    }
    $("cfg-user-hint").textContent = discovered.users.length
        ? `${discovered.users.length} discovered - pick or type a new one (optional)`
        : "no users discovered - leave empty or type one (optional)";

    await refreshSessionDropdown(seed?.sessionId ?? null);
    updateConnectButton();
    setStatus(
        `Ready - ${discovered.users.length} user(s), ${discovered.namespaces.length} namespace(s) discovered.`,
    );
}

async function refreshSessionDropdown(preselect = null) {
    const probe = probeClient();
    const userId = $("cfg-user").value.trim();
    const namespace = $("cfg-namespace").value || null;

    if (!probe) {
        populateDatalist($("cfg-session-options"), []);
        $("cfg-session-hint").textContent = "set a server URL first";
        return;
    }

    try {
        // userId is optional - AMS's /v1/working-memory/ accepts namespace
        // alone (or no filter), useful for apps that don't tag user_id.
        const sessions = await probe.listSessions(userId || null, namespace);
        populateDatalist($("cfg-session-options"), sessions);
        if (preselect && sessions.includes(preselect)) {
            $("cfg-session").value = preselect;
        } else if (!$("cfg-session").value && sessions.length === 1) {
            $("cfg-session").value = sessions[0];
        }

        // Hint reflects how the search was scoped.
        const scope =
            userId && namespace
                ? `user "${userId}" in "${namespace}"`
                : userId
                  ? `user "${userId}"`
                  : namespace
                    ? `namespace "${namespace}"`
                    : "all sessions";
        $("cfg-session-hint").textContent = sessions.length
            ? `${sessions.length} found for ${scope} - pick or type a new one`
            : `no sessions for ${scope} - type one`;
    } catch (err) {
        setStatus(`Couldn't list sessions: ${err.message}`);
    }
}

/**
 * Render a <select> with options for `values`, optionally prepending an
 * "(none)" entry. Used only for namespace, where "(none)" is a meaningful
 * explicit choice (filter by no namespace).
 */
function populateSelect(selectEl, values, selected, opts = {}) {
    selectEl.innerHTML = "";
    if (opts.allowNone) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "(none)";
        selectEl.appendChild(none);
    }
    for (const v of values) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        selectEl.appendChild(opt);
    }
    if (selected && [...selectEl.options].some((o) => o.value === selected)) {
        selectEl.value = selected;
    }
}

/**
 * Fill a <datalist> with suggestion <option>s. Paired with an `<input list>`
 * elsewhere to give a native browser combobox - pick a known value or type a
 * new one. AMS doesn't expose first-class user/session enumeration, so this
 * is how we surface what we derived from a long-term-memory scan.
 */
function populateDatalist(datalistEl, values) {
    datalistEl.innerHTML = "";
    for (const v of values) {
        const opt = document.createElement("option");
        opt.value = v;
        datalistEl.appendChild(opt);
    }
}
