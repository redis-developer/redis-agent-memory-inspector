/** Shorthand for `document.getElementById`. Used everywhere the DOM is touched. */
export const $ = (id) => document.getElementById(id);

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
