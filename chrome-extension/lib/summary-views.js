/**
 * Summary-view bootstrap.
 *
 * On Connect, the inspector ensures the two SummaryView configs it needs
 * exist in the target AMS. They're looked up by `name` (which we own and
 * namespace with `inspector:`) because AMS assigns the `id` server-side -
 * we can't pass our own. If a view is missing, we create it with
 * `continuous: true` so AMS's background worker keeps its partition
 * results refreshed without further help from the inspector.
 *
 * Self-installing means the inspector works against any AMS without a
 * separate setup script. Safe to run on every Connect - idempotent.
 *
 * The Cloud backend stubs return `[]` / throw; we wrap the create in a
 * try/catch and the caller treats a failed bootstrap as "no banners for
 * this connection." UI degrades gracefully, never blocks Connect.
 */

const VIEW_NAMES = {
    userProfile: "inspector:user-profile",
    sessionProfile: "inspector:session-profile",
};

/**
 * Ensure the two inspector views exist in the connected AMS.
 *
 * Returns { userProfileViewId, sessionProfileViewId } on success.
 * Returns null if the backend doesn't support summary views (Cloud) or
 * the calls fail - caller treats null as "skip banners."
 */
export async function ensureSummaryViews(client) {
    try {
        const existing = await client.listSummaryViews();
        const byName = new Map(existing.map((v) => [v.name, v]));

        const userProfile =
            byName.get(VIEW_NAMES.userProfile) ??
            (await client.createSummaryView({
                name: VIEW_NAMES.userProfile,
                source: "long_term",
                group_by: ["user_id"],
                continuous: true,
            }));

        const sessionProfile =
            byName.get(VIEW_NAMES.sessionProfile) ??
            (await client.createSummaryView({
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
