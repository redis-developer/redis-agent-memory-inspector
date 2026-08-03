/**
 * Summary-view helpers - views are first-class now: the inspector lists
 * whatever views exist (never auto-creates on connect, so deletes stick)
 * and offers explicit "create default views" when a default grouping is
 * missing. Views are matched by their group_by key set, not by name, so
 * any existing user-grouped view counts as the user default regardless of
 * who created it.
 */

const DEFAULT_GROUPINGS = [["user_id"], ["session_id"]];

// Names for views WE create; lookups never use them.
const DEFAULT_VIEW_NAMES = {
    user_id: "inspector:user-profile",
    session_id: "inspector:session-profile",
};

const sameGrouping = (a, b) =>
    a.length === b.length && b.every((key) => a.includes(key));

const hasGrouping = (views, groupBy) =>
    views.some((view) => sameGrouping(view.group_by ?? [], groupBy));

export const missingDefaultGroupings = (views) =>
    DEFAULT_GROUPINGS.filter((groupBy) => !hasGrouping(views, groupBy));

/**
 * List the endpoint's summary views. Returns null when the backend has no
 * summary-view support (Cloud, or older OSS servers) - caller hides the
 * pane. Other failures rethrow so transient errors don't read as
 * "unsupported".
 */
export async function listSummaryViews(client) {
    if (!client.summaryViews) return null;
    try {
        return (await client.summaryViews.list()) ?? [];
    } catch (err) {
        if (/\b404\b/.test(err.message)) return null;
        throw err;
    }
}

/** Create whichever default groupings are missing; returns the fresh list. */
export async function createDefaultViews(client, views) {
    for (const groupBy of missingDefaultGroupings(views ?? [])) {
        await client.summaryViews.create({
            name: DEFAULT_VIEW_NAMES[groupBy[0]],
            source: "long_term",
            group_by: groupBy,
            continuous: true,
        });
    }
    return (await client.summaryViews.list()) ?? [];
}
