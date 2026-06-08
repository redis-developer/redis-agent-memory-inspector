/** Shorthand for `document.getElementById`. Used everywhere the DOM is touched. */
export const $ = (id) => document.getElementById(id);

/**
 * Clone the content of a <template> by id and return the first element
 * child as a fresh DOM node ready to populate + append.
 *
 * Templates are placed adjacent to (right after) the slot they render
 * into, so a dev reading index.html can see the rendered structure at
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
 * Escape user-controlled strings before interpolating into `innerHTML`. The
 * rest of the codebase prefers `textContent` (which auto-escapes), so this is
 * only used in the rare innerHTML sites where we build small chunks of markup.
 */
export function escape(s) {
    return String(s).replace(
        /[&<>"']/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[c],
    );
}
