/** Shorthand for `document.getElementById`. Used everywhere the DOM is touched. */
export const $ = (id) => document.getElementById(id);

/**
 * Clone the content of a <template> by id and return the first element
 * child as a fresh DOM node ready to populate + append.
 *
 * Templates are placed adjacent to (right after) the slot they render
 * into, so a dev reading inspector.html can see the rendered structure at
 * the call site instead of having to trace createElement chains.
 *
 * Fail-loud if the template is missing - a typo'd id should crash
 * immediately, not silently return an empty fragment.
 */
export function fromTemplate(id) {
    const template = document.getElementById(id);
    if (!template || template.tagName !== "TEMPLATE") {
        throw new Error(`fromTemplate: no <template> with id="${id}"`);
    }
    return template.content.firstElementChild.cloneNode(true);
}

/**
 * Hover-revealed copy button ("⧉"), pinned visible while the "Copied"
 * confirmation shows so keyboard users get feedback too. Visibility is
 * CSS-driven: parents opt in with `.hover-copy-host`.
 */
const COPIED_VISIBLE_MS = 2000;

export function makeCopyButton(text, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hover-copy";
    button.textContent = "⧉";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return;
        }
        button.classList.add("is-copied");
        button.textContent = "✓";
        setTimeout(() => {
            button.classList.remove("is-copied");
            button.textContent = "⧉";
        }, COPIED_VISIBLE_MS);
    });
    return button;
}

/**
 * Wire a "Show more"/"Show less" toggle for clamped card text. The toggle
 * only appears when the (clamped) text actually overflows. Overflow is
 * measured with a ResizeObserver rather than a one-shot read, because
 * cards are often first rendered while their tab is hidden (zero
 * dimensions) - the observer re-checks once the text gains real height.
 *
 *   card    - element that carries the `.is-expanded` class (CSS drops the
 *             clamp when present)
 *   textEl  - the clamped text node to measure
 *   toggle  - the button to show/hide and relabel
 *   hasText - false forces the toggle hidden (e.g. placeholder text)
 */
export function wireClampToggle(card, textEl, toggle, hasText = true) {
    toggle.addEventListener("click", () => {
        const expanded = card.classList.toggle("is-expanded");
        toggle.textContent = expanded ? "Show less" : "Show more";
    });
    const measure = () => {
        if (card.classList.contains("is-expanded")) return;
        toggle.hidden =
            !hasText || textEl.scrollHeight <= textEl.clientHeight + 2;
    };
    new ResizeObserver(measure).observe(textEl);
}
