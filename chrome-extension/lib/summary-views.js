/**
 * Summary-view bootstrap.
 *
 * On Connect, the inspector ensures the two SummaryView configs it needs
 * exist in the target Redis Agent Memory. They're looked up by `name` (which we own and
 * namespace with `inspector:`) because Redis Agent Memory assigns the `id` server-side -
 * we can't pass our own. If a view is missing, we create it with
 * `continuous: true` so Redis Agent Memory's background worker keeps its partition
 * results refreshed without further help from the inspector.
 *
 *
 * Backends that don't support summary views (Cloud) don't expose
 * `client.summaryViews` at all - we short-circuit and return null. UI
 * degrades gracefully, never blocks Connect.
 */

const VIEW_NAMES = {
    userProfile: "inspector:user-profile",
    sessionProfile: "inspector:session-profile",
};

/**
 * Ensure the two inspector views exist in the connected Redis Agent Memory endpoint.
 *
 * Returns { userProfileViewId, sessionProfileViewId } on success.
 * Returns null if the backend doesn't support summary views (Cloud) or
 * the calls fail - caller treats null as "skip banners."
 */
export async function ensureSummaryViews(client) {
    if (!client.summaryViews) return null;
    try {
        const existing = await client.summaryViews.list();
        const byName = new Map(existing.map((v) => [v.name, v]));

        const userProfile =
            byName.get(VIEW_NAMES.userProfile) ??
            (await client.summaryViews.create({
                name: VIEW_NAMES.userProfile,
                source: "long_term",
                group_by: ["user_id"],
                continuous: true,
            }));

        const sessionProfile =
            byName.get(VIEW_NAMES.sessionProfile) ??
            (await client.summaryViews.create({
                name: VIEW_NAMES.sessionProfile,
                source: "long_term",
                group_by: ["session_id"],
                continuous: true,
            }));

        return {
            userProfileViewId: userProfile.id,
            sessionProfileViewId: sessionProfile.id,
        };
    } catch (err) {
        console.warn(
            "[inspector] summary-view bootstrap skipped:",
            err.message,
        );
        return null;
    }
}
