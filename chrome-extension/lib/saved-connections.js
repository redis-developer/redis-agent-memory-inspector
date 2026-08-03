/**
 * Saved-connections persistence layer.
 *
 * Stores the user's connection configs (URL, store ID, API key, refresh
 * intervals, etc.) in `chrome.storage.session` so they survive opening +
 * closing the inspector window during the same Chrome session. Wiped
 * when the user quits Chrome - that's the deliberate trade-off the user
 * chose vs. `chrome.storage.local` (which would persist on disk).
 *
 * Each entry has a stable `id` (so the "x" button can target it
 * unambiguously) and an `alias` derived automatically from the config:
 *
 *   - OSS:   hostname[:port] from the URL  (e.g. "localhost:8000")
 *   - Cloud: the storeId                   (e.g. "store-abc-123")
 *
 * `lastUsedId` tracks which entry to auto-select when the connect panel
 * re-opens, so the user just sees the "live" badge and clicks Connect.
 */

const STORAGE_KEY = "savedConnections";
const ACTIVE_KEY = "activeConnection";

/**
 * chrome.storage.session inside the extension; a localStorage-backed
 * stand-in when the page is opened outside Chrome's extension runtime
 * (local development against a static server).
 */
const store =
    typeof chrome !== "undefined" && chrome.storage?.session
        ? chrome.storage.session
        : {
              async get(key) {
                  const raw = localStorage.getItem(key);
                  return { [key]: raw ? JSON.parse(raw) : undefined };
              },
              async set(items) {
                  for (const [key, value] of Object.entries(items)) {
                      localStorage.setItem(key, JSON.stringify(value));
                  }
              },
              async remove(key) {
                  localStorage.removeItem(key);
              },
          };

/**
 * Compute the human-readable alias for a config. OSS uses the hostname
 * from the URL (with port if present); Cloud uses the storeId since
 * that's what the user named in the Redis Cloud console.
 */
export function aliasFor(config) {
    if (config.backend === "cloud") {
        return config.storeId || "(no store id)";
    }
    try {
        const u = new URL(config.url);
        return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
        return config.url || "(no url)";
    }
}

/**
 * Identity key used to dedupe entries on save. Same backend + url +
 * storeId means "the same connection" - we update in place rather than
 * appending. Changing any of those three creates a new entry.
 */
function identityOf(config) {
    return [config.backend, config.url, config.storeId ?? ""].join("|");
}

function newId() {
    return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readState() {
    try {
        const data = await store.get(STORAGE_KEY);
        const state = data?.[STORAGE_KEY] ?? {};
        return {
            entries: Array.isArray(state.entries) ? state.entries : [],
            lastUsedId: state.lastUsedId ?? null,
        };
    } catch (err) {
        console.warn("[saved-connections] read failed:", err.message);
        return { entries: [], lastUsedId: null };
    }
}

async function writeState(state) {
    try {
        await store.set({ [STORAGE_KEY]: state });
    } catch (err) {
        console.warn("[saved-connections] write failed:", err.message);
    }
}

/** Returns the full list of saved entries (oldest first). */
export async function loadAll() {
    const { entries } = await readState();
    return entries;
}

/** Returns the entry the user last connected to, or null. */
export async function getLastUsed() {
    const { entries, lastUsedId } = await readState();
    if (!lastUsedId) return null;
    return entries.find((e) => e.id === lastUsedId) ?? null;
}

/**
 * Upsert: if a stored entry has the same identity (backend + url +
 * storeId), replace it with the new config; otherwise append. Marks the
 * affected entry as last-used either way. Returns the saved entry so
 * the caller has its id.
 */
export async function save(config) {
    const state = await readState();
    const identity = identityOf(config);
    const existing = state.entries.find((e) => identityOf(e) === identity);
    const entry = {
        id: existing?.id ?? newId(),
        alias: aliasFor(config),
        ...config,
    };
    if (existing) {
        state.entries = state.entries.map((e) => (e.id === existing.id ? entry : e));
    } else {
        state.entries = [...state.entries, entry];
    }
    state.lastUsedId = entry.id;
    await writeState(state);
    return entry;
}

/** Remove a saved entry by id. If it was last-used, clear that pointer too. */
export async function remove(id) {
    const state = await readState();
    state.entries = state.entries.filter((e) => e.id !== id);
    if (state.lastUsedId === id) state.lastUsedId = null;
    await writeState(state);
}

// ---------- active connection handoff (config.html → inspector.html) ----------

/**
 * The "active connection" is what config.html writes to session storage
 * before navigating to inspector.html. The inspector reads it on load to
 * instantiate its client. Separate from `savedConnections` (the list of
 * stored configs) because it represents "what's being inspected right
 * now," not "what's available to pick from."
 */
export async function setActive(config) {
    try {
        await store.set({ [ACTIVE_KEY]: config });
    } catch (err) {
        console.warn("[saved-connections] setActive failed:", err.message);
    }
}

export async function getActive() {
    try {
        const data = await store.get(ACTIVE_KEY);
        return data?.[ACTIVE_KEY] ?? null;
    } catch (err) {
        console.warn("[saved-connections] getActive failed:", err.message);
        return null;
    }
}

export async function clearActive() {
    try {
        await store.remove(ACTIVE_KEY);
    } catch (err) {
        console.warn("[saved-connections] clearActive failed:", err.message);
    }
}
