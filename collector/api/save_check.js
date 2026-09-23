/* A credential saved on the Settings page is tested once, then and there, and
   the banner shows that verdict from the moment of the save.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production 2026-09-23. The operator saved UBER_WEB_COOKIE_EGARI
   at 08:30:22Z. The banner kept showing it as stopped: "redirected to
   auth.uber.com — the session is no longer signed in". That row was written at
   08:31:28Z by a collector run that had loaded its settings at 08:30:00Z and
   asked Uber with the previous cookie. The saved cookie worked: production's
   paste check passed it at 08:40:51Z, and a report request made with the
   stored value came back "accepted" at 08:41:07Z. Nothing tested the new
   value until the next run, so for up to half an hour the only verdict on
   record was about a value nobody was using.

   Two halves fix it, and both are needed:

     here            a save tests what it stored and writes the verdict onto
                     every banner row for that key, stamped with the stored
                     version (schema_v82);
     noteCredential  (src/auth_state.js) drops an observation made with a
                     value that has since been replaced. Without that, the
                     run still in flight with the old cookie would overwrite
                     this verdict within the minute, as it did here.

   ON SAVE ONLY, never on a page view. The operator asked for exactly that
   ("not page refresh. when settings refresh only"), and it is also the only
   safe rate: the Uber check generates a report, and Uber allows three in
   flight per org, so a check per page view would compete with the
   collector's own reports.

   WHAT EACH VERDICT WRITES. A check answers "should this be stored?", and
   the banner asks "what is true of this credential now?". They are not the
   same question, so a verdict is translated into the banner's vocabulary
   (api/auth_routes.js) by what it ESTABLISHED about the credential:

     ok        the credential authenticated: a pass, or a check that saw the
               session read before something else refused the request (the
               Yango console's CDN edge; the collector records the same
               evidence as ok). last_ok_at moves, because it did authenticate.
     invalid   the provider refused THIS credential. Red, with "refused when
               saved" in front, so nobody takes it for the previous value's
               failure.
     saved     nothing was established: no live check exists for the key (an
               FMS password), the provider could not be reached, or the
               refusal was not about this credential (the Yango portal refusing
               the park with or without a session). Quiet on the banner, and
               the surface's next run writes over it.
     cleared   the key was removed from the Settings page. Written as saved,
               and NOT tested: the value now in force is whatever each process
               holds in its own environment, and the API's environment is not
               the collector's (UBER_WEB_COOKIE is set on one component only).

   Two kinds of row are left as they were and only re-stamped: `moved` (the
   endpoint changed) and `blocked` (something in front of the API refuses the
   caller). A new credential cannot fix either, and painting them "accepted
   when saved" would hide a real fault until the surface next ran, up to a
   week for the weekly profile read. Found by an independent review.

   Only rows that already exist are touched. A key the banner has never
   observed has no provider or fleet to file a verdict under, and inventing a
   row would put a credential on the banner that no surface uses. */
import { checkStored, checkFleet } from '../src/credcheck.js';
import { SETTING_VERSION_SQL, setSetting, loadSettings, get } from '../src/settings.js';

/** The banner state a verdict becomes. See the table above. */
export function stateOf(v) {
  if (v.verdict === 'pass' || (v.verdict === 'unknown' && v.authenticates)) return 'ok';
  if (v.verdict === 'fail' && v.blames !== 'other') return 'invalid';
  return 'saved';
}

/** The row's detail: the check's own words, prefixed so that a reader can
    tell a verdict made at save time from one the collector made. */
export function saveDetail(v) {
  const said = v.detail ? String(v.detail) : '';
  const state = v.verdict === 'cleared' ? 'cleared' : stateOf(v);
  const text = {
    ok: `accepted when saved — ${said || 'the provider authenticated it'}`,
    invalid: `refused when saved — ${said || 'the provider refused it'}`,
    saved: `saved, not tested — ${said || 'no live check exists for it'}; each surface tests it `
      + 'the next time it runs',
    cleared: 'cleared on the Settings page — each process now uses its own environment value if it '
      + 'has one, and each surface\u2019s next run says whether it does',
  }[state];
  return text.slice(0, 240);
}

/* A row about the ENDPOINT or the CALLER, not the credential. Kept. */
const KEEP = ['moved', 'blocked'];
/* Inlined rather than bound: a constant list, and a JS array bound to a
   Postgres parameter is the one shape docs/COVERAGE.md records passing on
   PGlite and failing on production. */
const KEEP_SQL = KEEP.map((k) => `'${k}'`).join(', ');

/**
 * Test each saved key once per fleet its check depends on, and write the
 * verdict onto that key's banner rows, stamped with the version stored now.
 *
 * @param db     anything with query(text, params)
 * @param keys   the setting keys that were just written or cleared
 * @param opts.cleared  the keys among them that were REMOVED, which are never
 *                      tested (see the table above)
 * @param opts.known    Map key → { verdict, detail, untested?, blames?,
 *                      authenticates? } the caller has already established
 *                      (the paste box tests before it writes, and testing
 *                      twice would generate a second Uber report for nothing)
 * @param opts.check    (key, { fleet }) → verdict; checkStored in production
 * @param opts.store / opts.reload   setSetting / loadSettings, injected so a
 *                      test harness that stubs them is not bypassed
 * @returns one entry per key and fleet: { key, fleet, verdict, state, detail, rows }
 */
export async function recordSaved(db, keys, {
  cleared = new Set(), known = new Map(), check = checkStored, store = setSetting, reload = loadSettings,
} = {}) {
  const tested = await Promise.all([...new Set(keys)].map((key) => one(key).catch((e) => [{
    /* The value is already stored. A failure here must not turn a completed
       save into an error, so it is reported beside it instead. */
    key, fleet: null, verdict: 'error', detail: String(e?.message || e).slice(0, 200), rows: 0,
  }])));
  return tested.flat();

  async function one(key) {
    const { rows } = await db.query(
      'SELECT DISTINCT fleet_id FROM credential_state WHERE credential = $1', [key]);
    if (!rows.length) return [];
    /* Grouped by the fleet the check depends on, so an Uber cookie with four
       banner rows (reports, vehicles, profiles, timeline) is tested once. */
    const groups = new Map();
    for (const { fleet_id: f } of rows) {
      const g = checkFleet(key, f);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    const out = [];
    for (const [fleet, fleetIds] of groups) {
      let v;
      if (cleared.has(key)) {
        v = { verdict: 'cleared' };
      } else if (known.has(key)) {
        const k = known.get(key);
        v = { ...k, verdict: k.untested ? 'untested' : k.verdict };
      } else {
        v = await check(key, { fleet });
        /* A check that hands back a different credential has spent the one it
           was given, so the successor is stored before anything is recorded.
           checkStored only reports one when the provider really returned a
           new value, and only for the key it tested; Bolt's portal was
           measured on 2026-09-22 not to rotate at all. */
        let moved = false;
        for (const [k, val] of Object.entries(v.keys || {})) {
          if (k === key && val && val !== get(k)) { await store(k, val); moved = true; }
        }
        if (moved) await reload(true);
      }
      const state = v.verdict === 'cleared' ? 'saved' : stateOf(v);
      const detail = saveDetail(v);
      const VERSION = `(SELECT ${SETTING_VERSION_SQL} FROM app_setting WHERE key = $1)`;
      let n = 0;
      for (const f of fleetIds) {
        const r = await db.query(
          `UPDATE credential_state
              SET state = $3::text, detail = $4::text, checked_at = now(),
                  last_ok_at = CASE WHEN $3::text = 'ok' THEN now() ELSE last_ok_at END,
                  value_version = ${VERSION}
            WHERE credential = $1 AND fleet_id = $2 AND state NOT IN (${KEEP_SQL})`,
          [key, f, state, detail]);
        n += r.rowCount ?? r.affectedRows ?? 0;
        /* A moved endpoint or a blocked caller is as true of the new value as
           of the old one: re-stamped so it is read as current, not replaced. */
        await db.query(
          `UPDATE credential_state SET value_version = ${VERSION}
            WHERE credential = $1 AND fleet_id = $2 AND state IN (${KEEP_SQL})`,
          [key, f]);
      }
      out.push({ key, fleet, verdict: v.verdict, state, detail, rows: n });
    }
    return out;
  }
}
