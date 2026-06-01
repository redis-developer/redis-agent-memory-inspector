/**
 * Visibility-aware polling controller. The caller supplies two async
 * callbacks (one per pane) and their intervals; the controller fires them on
 * the right cadence, pauses on `visibilitychange` when the inspector window
 * is hidden, and resumes when it's visible again.
 *
 * Returned API: `start()`, `stop()`, `runNow()`. The caller owns the
 * lifecycle - we don't auto-start so that the entry point can decide *when*
 * polling begins (e.g., only after a successful Connect).
 */
export function createPoller({ onWorking, onLongTerm, workingMs, longTermMs }) {
    let timers = { working: null, longterm: null };
    let started = false;

    function start() {
        stop();
        started = true;
        onWorking?.();
        onLongTerm?.();
        timers.working = setInterval(() => onWorking?.(), workingMs);
        timers.longterm = setInterval(() => onLongTerm?.(), longTermMs);
    }

    function stop() {
        if (timers.working) clearInterval(timers.working);
        if (timers.longterm) clearInterval(timers.longterm);
        timers = { working: null, longterm: null };
    }

    /** Trigger both callbacks immediately, in parallel. Used by manual refresh. */
    function runNow() {
        return Promise.all([onWorking?.(), onLongTerm?.()]);
    }

    document.addEventListener("visibilitychange", () => {
        if (!started) return;
        if (document.hidden) stop();
        else start();
    });

    return { start, stop, runNow };
}
