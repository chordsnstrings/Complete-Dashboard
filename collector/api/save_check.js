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

   WHAT EACH VERDICT WRITES. The row's `state` is the banner's vocabulary
   (api/auth_routes.js), so a verdict is translated rather than stored raw:

     pass      ok        the saved value authenticated. The red row goes.
                         last_ok_at moves, because the credential did just
                         authenticate.
     fail      invalid   red, with the provider's own reason and "refused when
                         saved" in front of it, so nobody takes it for the
                         previous value's failure.
     unknown   unknown   amber: the provider could not be reached, which says
                         nothing about the credential either way.
     untested  saved     quiet: no check exists for this key (an FMS password,
                         a CABMAN login), so the collector's next run is its
                         first test. Neither red nor green, because neither
                         is known.
     missing   missing   the key was cleared and nothing else configures it.

   Only rows that already exist are touched. A key the banner has never
   observed has no provider or fleet to file a verdict under, and inventing a
   row would put a credential on the banner that no surface uses. */
import { checkStored, checkFleet } from '../src/credcheck.js';
import { SETTING_VERSION_SQL, setSetting, loadSettings, get } from '../src/settings.js';

/** The banner state a save-time verdict becomes. See the table above. */
export const SAVE_STATE = {
  pass: 'ok', fail: 'invalid', unknown: 'unknown', untested: 'saved', missing: 'missing',
};

/** The row's detail: the verdict's own words, prefixed so that a reader can
    tell a verdict made at save time from one the collector made. */
export function saveDetail(verdict, detail) {
  const said = detail ? String(detail) : '';
  const text = {
    pass: `accepted when saved — ${said || 'the provider authenticated it'}`,
    fail: `refused when saved — ${said || 'the provider refused it'}`,
    unknown: `saved, but not tested — ${said || 'the provider could not be reached'}`,
    untested: `saved, not tested yet — ${said || 'no live check exists for it'}; `
      + 'the collector’s next run is its first test',
    missing: `cleared on the Settings page — ${said || 'nothing is configured for it now'}`,
  }[verdict];
  return (text || said).slice(0, 240);
}

/**
 * Test each saved key once per fleet its check depends on, and write the
 * verdict onto that key's banner rows, stamped with the version stored now.
 *
 * @param db     anything with query(text, params)
 * @param keys   the setting keys that were just written or cleared
 * @param opts.known   Map key → { verdict, detail, untested? } the caller has
 *                     already established (the paste box tests before it
 *                     writes, and testing twice would generate a second Uber
 *                     report for nothing)
 * @param opts.check   (key, { fleet }) → verdict; checkStored in production
 * @param opts.store / opts.reload   setSetting / loadSettings, injected so a
 *                     test harness that stubs them is not bypassed
 * @returns one entry per key and fleet tested: { key, fleet, verdict, detail, rows }
 */
export async function recordSaved(db, keys, {
  known = new Map(), check = checkStored, store = setSetting, reload = loadSettings,
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
      let v = known.get(key);
      if (v) {
        v = { verdict: v.untested ? 'untested' : v.verdict, detail: v.detail };
      } else {
        v = await check(key, { fleet });
        /* A check that hands back a successor credential has spent the one it
           was given, so the successor is stored before anything is recorded.
           Bolt's portal was measured on 2026-09-22 NOT to do this (fifteen
           exchanges of one token, all accepted, no successor), but
           src/credcheck.js still carries the successor if one ever comes back,
           and dropping it here would leave a dead token stored. */
        let moved = false;
        for (const [k, val] of Object.entries(v.keys || {})) {
          if (val && val !== get(k)) { await store(k, val); moved = true; }
        }
        if (moved) await reload(true);
      }
      const state = SAVE_STATE[v.verdict] || 'unknown';
      const detail = saveDetail(v.verdict, v.detail);
      let n = 0;
      for (const f of fleetIds) {
        const r = await db.query(
          `UPDATE credential_state
              SET state = $3, detail = $4, checked_at = now(),
                  last_ok_at = CASE WHEN $3 = 'ok' THEN now() ELSE last_ok_at END,
                  value_version = (SELECT ${SETTING_VERSION_SQL} FROM app_setting WHERE key = $1)
            WHERE credential = $1 AND fleet_id = $2`,
          [key, f, state, detail]);
        n += r.rowCount ?? r.affectedRows ?? 0;
      }
      out.push({ key, fleet, verdict: v.verdict, detail, rows: n });
    }
    return out;
  }
}
