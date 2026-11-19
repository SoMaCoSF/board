import { getActivity } from './_lib/activity.ts'

/**
 * `GET /api/activity` — one JSON snapshot of the board's agent activity.
 * On Vercel the deployment acts as its project, with its OIDC token, once the
 * team grants it the board; elsewhere the board is the one `BOARD_URL` names,
 * or the fixture set (see `_lib/activity.ts`).
 */
export async function GET(): Promise<Response> {
  try {
    const snapshot = await getActivity()
    return Response.json(snapshot, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'the board did not answer' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    )
  }
}
