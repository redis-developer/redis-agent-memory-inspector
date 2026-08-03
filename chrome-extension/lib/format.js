/**
 * Absolute timestamp: "YYYY-MM-DD HH:MM:SS" in the user's local timezone.
 * Compact, sortable, unambiguous. Paired in the UI with `relativeTime` as a
 * hover tooltip so both forms are available at once.
 */
export function formatDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

/** Relative form: "now", "5s ago", "32m ago", "2h ago", "3d ago". */
export function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "-";
    const delta = Math.floor((Date.now() - then) / 1000);
    if (delta < 5) return "now";
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

/** "HH:MM:SS" of right now, used in status messages like "updated 14:38:25". */
export function timeStr() {
    return new Date().toLocaleTimeString([], { hour12: false });
}

/** "3 records", "1 memory", "2 memories". */
export function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** `01KTR2ABCDEF...` -> `01KTR2…RGFW6G`; short ids pass through. */
export function shortId(id) {
    const s = String(id ?? "");
    return s.length > 13 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}
