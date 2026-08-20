/**
 * Per-pane auto-refresh control: "Last refresh:" label + manual ↻ + a
 * chevron popover with an Auto Refresh switch and an editable rate.
 * Enablement and rate persist per pane (localStorage), so the choice
 * survives tab switches and reloads.
 *
 * There is no background polling unless the switch is on.
 */

import { relativeTime } from "./format.js";

const DEFAULT_RATE_S = 5;
const MIN_RATE_S = 1;
// The label re-renders on this cadence so "now" ages into "30s ago".
const LABEL_TICK_MS = 30_000;

const store = {
    enabled: (key) => `inspector:autoRefresh:${key}`,
    rate: (key) => `inspector:autoRefreshRate:${key}`,
};

/**
 * Build one control. Returns { element, markRefreshed }. The caller appends
 * `element` into its pane header and calls `markRefreshed()` after every
 * successful fetch (manual or its own).
 */
export function createAutoRefresh({ key, onRefresh, refreshLabel }) {
    let enabled = localStorage.getItem(store.enabled(key)) === "true";
    let rateS = Number(localStorage.getItem(store.rate(key))) || DEFAULT_RATE_S;
    let lastRefreshTime = null;
    let timer = null;

    const root = document.createElement("div");
    root.className = "auto-refresh";

    const label = document.createElement("span");
    label.className = "auto-refresh-label";

    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "icon-button auto-refresh-button";
    refreshButton.textContent = "↻";
    refreshButton.title = refreshLabel ?? "Refresh";
    refreshButton.setAttribute("aria-label", refreshLabel ?? "Refresh");
    refreshButton.addEventListener("click", async () => {
        refreshButton.classList.add("is-spinning");
        setTimeout(() => refreshButton.classList.remove("is-spinning"), 400);
        await onRefresh();
    });

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "icon-button auto-refresh-chevron";
    chevron.textContent = "▾";
    chevron.title = "Auto refresh settings";
    chevron.setAttribute("aria-label", "Auto refresh settings");
    chevron.setAttribute("aria-haspopup", "true");
    chevron.setAttribute("aria-expanded", "false");

    const popover = document.createElement("div");
    popover.className = "auto-refresh-popover";
    popover.hidden = true;

    const switchRow = document.createElement("label");
    switchRow.className = "auto-refresh-switch";
    const switchInput = document.createElement("input");
    switchInput.type = "checkbox";
    switchInput.checked = enabled;
    const switchText = document.createElement("span");
    switchText.textContent = "Auto Refresh";
    switchRow.appendChild(switchInput);
    switchRow.appendChild(switchText);

    const rateRow = document.createElement("label");
    rateRow.className = "auto-refresh-rate";
    const rateText = document.createElement("span");
    rateText.textContent = "Refresh rate:";
    const rateInput = document.createElement("input");
    rateInput.type = "number";
    rateInput.min = String(MIN_RATE_S);
    rateInput.step = "1";
    rateInput.value = String(rateS);
    const rateUnit = document.createElement("span");
    rateUnit.textContent = "s";
    rateRow.appendChild(rateText);
    rateRow.appendChild(rateInput);
    rateRow.appendChild(rateUnit);

    popover.appendChild(switchRow);
    popover.appendChild(rateRow);

    root.appendChild(label);
    root.appendChild(refreshButton);
    root.appendChild(chevron);
    root.appendChild(popover);

    chevron.addEventListener("click", () => {
        popover.hidden = !popover.hidden;
        chevron.setAttribute("aria-expanded", String(!popover.hidden));
    });
    document.addEventListener("click", (event) => {
        if (event.target.closest(".auto-refresh") === root) return;
        popover.hidden = true;
        chevron.setAttribute("aria-expanded", "false");
    });

    switchInput.addEventListener("change", () => {
        enabled = switchInput.checked;
        localStorage.setItem(store.enabled(key), String(enabled));
        restartTimer();
    });

    rateInput.addEventListener("change", () => {
        rateS = Math.max(MIN_RATE_S, Number(rateInput.value) || DEFAULT_RATE_S);
        rateInput.value = String(rateS);
        localStorage.setItem(store.rate(key), String(rateS));
        restartTimer();
    });

    function restartTimer() {
        clearInterval(timer);
        timer = null;
        if (enabled) {
            timer = setInterval(() => onRefresh(), rateS * 1000);
        }
    }

    function renderLabel() {
        label.textContent = lastRefreshTime
            ? `Last refresh: ${relativeTime(lastRefreshTime)}`
            : "Last refresh: -";
    }

    setInterval(renderLabel, LABEL_TICK_MS);
    renderLabel();
    restartTimer();

    return {
        element: root,
        markRefreshed() {
            lastRefreshTime = new Date().toISOString();
            renderLabel();
        },
    };
}
