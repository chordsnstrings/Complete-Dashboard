/* Which credentials are working, for the banner every page carries.
   ─────────────────────────────────────────────────────────────────────────
   This exists because an expired Uber web session did not look like a
   failure. Measured live on 2026-08-26: with the `sid` cookie dropped, the
   supplier GraphQL request follows a redirect to auth.uber.com, answers 404,
   and the collector read that as a week in which nobody drove — reporting the
   run 'ok'. The most perishable credential in this deployment could have
   stopped on a Friday and every page would have gone on saying every source
   was healthy. src/auth_state.js carries the whole measurement and does the
   detection; this reads what it recorded.

   Three states, and the difference between them is what an operator does next:

     stopped   a credential was refused, or bounced to a login page. Somebody
               has to replace it, and until they do the surfaces behind it are
               collecting nothing. Red.
     at risk   the credential still authenticates, but the surface behind it
               has not completed a run in far longer than its own schedule —
               so it is failing at something, and a credential is the usual
               reason. Amber.
     missing   configured for one fleet and absent for another that has data.
               A known gap rather than a fault; it never turns red, because
               nothing broke.

   What this deliberately does NOT do is predict expiry from the cookie. The
   jar holds one dated token, `sp-jwt-session`, and it was measured NOT to be
   the session: dropping it leaves both fleets answering 200 with data, while
   dropping `sid` or `csid` bounces to the login page. Egari's `jwt-session`
   expired three hours before this was written and Egari collected normally
   through it. A banner driven off those dates would have gone amber on a
   working fleet within the week, and a banner that is sometimes wrong is one
   nobody reads. So the amber here is earned by an observed stall, not by a
   date that turned out to describe something else. */

/** How long a source may go without finishing before it counts as stalled.
    Generous against each source's real cadence — the half-hourly incremental,
    CABMAN's five minutes — because one missed tick is a restart and six is a
    problem. */
const STALL_HOURS = {
  cabman: 2, uber: 6, uber_fleet: 6, fms: 6, yango: 12, hotel: 12, bolt: 24,
};
const DEFAULT_STALL_H = 12;

/* What each recorded credential state means to a reader. 'ok' is absent on
   purpose: a working credential's severity is decided by the stall clock, not
   by this table. */
const SEVERITY_OF = {
  expired: 'stopped',
  invalid: 'stopped',
  missing: 'missing',
  /* An endpoint that moved. Scored 'stopped' because nothing is being
     collected — the severity is identical — but it is a different STATE and
     therefore a different errand: somebody changes a URL rather than
     re-capturing a session that already works. src/auth_state.js wrote
     'expired' for these on purpose while this map had no row for the word,
     since an unknown state falls to 'at-risk' and would have taken a dead
     surface from red to amber. supplier.uber.com → fleethub.uber.com is the
     measured case; days went into re-pasting cookies that were fine. */
  moved: 'stopped',
  /* TWO more states with the severity of 'invalid' and neither of its errands.
     ─────────────────────────────────────────────────────────────────────────
     'moved' exists because "stopped working" sent somebody to re-capture a
     working cookie when the URL was what had changed. The same mistake had two
     more shapes in this fleet on 2026-09-07, and the banner was making both:

     unentitled — the credential AUTHENTICATES and is not permitted the thing
       being asked for. BOLT_CLIENT_ID reads company 142897 (Egari) and is
       refused 142868 (Ecosine) with NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED.
       Nothing an operator does to the secret changes that; somebody with Bolt
       portal access adds the company to the fleet-integration app. The banner
       said "stopped working … until they are replaced", and replacing it would
       have produced a new secret with exactly the same entitlement.

     blocked — the credential authenticates and something IN FRONT of the API
       refuses the caller. fleet.yango.com answers 403 with an HTML page from a
       CDN edge while every Yango API refusal is JSON, the park returns 200 and
       names ECOSINE TRANSPORTS LLC, and the same call answers 401 with the
       cookie removed — a pair unreachable from one origin unless an edge is
       deciding. Not a credential, not a URL: where the call comes from.

     Both scored 'stopped' on the reasoning that "nothing is being collected
     and the severity is honestly identical". THAT PREMISE IS FALSE, and it was
     false about the very row it was written for.

     A credential covers a SURFACE. A channel can have several. Bolt has two:
     the fleet-integration API, on client credentials, and the portal, on a
     user session. BOLT_CLIENT_ID is refused company 142868 — so the FI ROSTER
     collects nothing for Ecosine — while the portal collects Ecosine's trips
     on the same runs. Measured on production 2026-09-10: **34,897 Bolt
     bookings for ecosine** and 158 drivers seen on them, beside a banner
     reading "the surfaces behind them are collecting nothing" and "never
     authenticated".

     That is a reason which is not the true one, on the page whose whole
     purpose is to give the true one. An operator reading it either goes
     hunting for missing Bolt data that is already there, or stops trusting
     the banner — and the second is worse and permanent.

     So these two states are scored against EVIDENCE rather than assumption:
     if the source is still collecting for that fleet — `lastOk` below, which
     already means exactly "a run finished and wrote rows" — the channel is
     DEGRADED, one surface of it permanently unavailable. Only when nothing is
     arriving at all is it stopped. The errand is unchanged either way; what
     changes is the claim about what it costs. */
  unentitled: 'stopped',
  blocked: 'stopped',
  /* The states above are re-scored per row when the channel is still
     collecting; see SURFACE_STATES where the rows are built. */
  /* A check that could not run is not a check that passed — the Yango
     cookie-free comparison records this when it cannot complete. */
  unknown: 'at-risk',
};

/* One clause per errand, so a state that is added to the table above and not
   to this one is a state the headline cannot silently describe as a
   replacement. `whole` is the sentence when EVERY stopped row is this state;
   `part` is the clause appended when only some are. */
export const ERRANDS = {
  moved: {
    noun: 'endpoint',
    whole: (n) => `${n === 1 ? 'An endpoint has' : `${n} endpoints have`} moved — nothing is `
      + 'being collected from them, and the credential is not what is wrong: the URL is',
    part: (n) => `${n} of them because the endpoint moved, not the credential`,
  },
  unentitled: {
    noun: 'credential',
    whole: (n) => `${n === 1 ? 'A credential is' : `${n} credentials are`} not permitted what `
      + `${n === 1 ? 'it is' : 'they are'} asking for — ${n === 1 ? 'it authenticates' : 'they authenticate'} `
      + 'and the account is refused the company or park, so replacing the secret changes nothing: '
      + 'the access has to be granted in the provider\u2019s portal',
    /* Singular and plural, because these clauses are joined onto a count and
       "1 of them authenticate" is a sentence a reader stops trusting. */
    part: (n) => `${n} of them ${n === 1 ? 'authenticates' : 'authenticate'} and `
      + `${n === 1 ? 'is' : 'are'} refused the company or park, which is a permission to grant `
      + 'rather than a secret to replace',
  },
  blocked: {
    noun: 'call',
    whole: (n) => `${n === 1 ? 'A surface is' : `${n} surfaces are`} being refused before the request `
      + `reaches the provider — ${n === 1 ? 'the credential authenticates' : 'the credentials authenticate'} `
      + 'and something in front of the API is turning this caller away, so there is nothing to re-paste',
    part: (n) => `${n} of them refused in front of the API, where no credential is being read`,
  },
};

/* The states that describe ONE SURFACE of a channel rather than the channel.
   A credential in one of these can be permanently refused while the channel
   keeps collecting through another surface — which is exactly Bolt: the
   fleet-integration roster is refused for Ecosine and the portal delivers its
   trips on the same run. */
const SURFACE_STATES = new Set(['unentitled', 'blocked']);

export function authRoutes(app, { q, wrap }) {
  app.get('/api/auth', wrap(async (_req, res) => {
    const [creds, runs] = await Promise.all([
      q(`SELECT provider, fleet_id, credential, state, detail, surface,
                last_ok_at, checked_at
           FROM credential_state ORDER BY provider, fleet_id, credential`).catch(() => []),
      /* The freshest finish per source and fleet, so a stall is measured
         against the thing that actually runs rather than against a source
         name that covers two fleets with different credentials. */
      q(`SELECT DISTINCT ON (source, coalesce(fleet_id,'*'))
                source, coalesce(fleet_id,'*') AS fleet_id, status, finished_at, rows_written
           FROM collection_run
          ORDER BY source, coalesce(fleet_id,'*'), finished_at DESC NULLS LAST`).catch(() => []),
    ]);

    const now = Date.now();
    const ageH = (t) => (t ? (now - Date.parse(t)) / 3600e3 : null);
    const lastOk = new Map();
    for (const r of runs) {
      if (r.status !== 'ok' && r.status !== 'partial') continue;
      /* A partial that wrote nothing is not evidence that anything works, and
         this clock is the product's only measure of "the credential is still
         collecting". Rows are what a working credential produces. */
      if (r.status === 'partial' && !(Number(r.rows_written) > 0)) continue;
      lastOk.set(`${r.source}|${r.fleet_id}`, r.finished_at);
    }

    const rows = creds.map((c) => {
      const runAge = ageH(lastOk.get(`${c.provider}|${c.fleet_id}`)
        ?? lastOk.get(`${c.provider}|*`));
      const limit = STALL_HOURS[c.provider] ?? DEFAULT_STALL_H;
      /* A stall only means something while the credential still works: once it
         is refused, the stall is a consequence and saying both would report
         one fault twice. */
      const stalled = c.state === 'ok' && runAge != null && runAge > limit;
      return {
        ...c,
        last_ok_age_h: ageH(c.last_ok_at),
        run_age_h: runAge == null ? null : Math.round(runAge * 10) / 10,
        stall_limit_h: limit,
        /* Exhaustive, and its default is NOT 'ok'.
           ─────────────────────────────────────────────────────────────────
           This tested only for 'expired' and 'missing', so every other state
           fell through to the stall clock — which only fires for state 'ok'
           — and landed on 'ok'. Measured on production 2026-09-02, minutes
           after the collector first learned to record its refusals: two rows
           read state 'invalid' and severity 'ok', with stopped 0 and no
           headline at all. One of them was a Bolt token minted for the wrong
           fleet's owner and the other a Yango session answering 403.

           A state this does not know is at-risk rather than fine, because
           that is the failure that just happened: a state added by one change
           and silently rendered healthy by another. */
        /* Whether the CHANNEL is still delivering, whatever this one
           credential's surface is doing. runAge comes from lastOk, which
           counts a run only if it finished and wrote rows — so this is
           evidence, not optimism. */
        still_collecting: runAge != null && runAge <= limit,
        severity: c.state === 'ok'
          ? (stalled ? 'at-risk' : 'ok')
          /* A surface-level refusal on a channel that is still collecting is
             degraded, not stopped. See SEVERITY_OF: saying "collecting
             nothing" over 34,897 collected bookings is the failure this
             guards against. */
          : (SURFACE_STATES.has(c.state) && runAge != null && runAge <= limit
            ? 'degraded'
            : SEVERITY_OF[c.state] || 'at-risk'),
      };
    });

    const bad = rows.filter((r) => r.severity === 'stopped');
    const degraded = rows.filter((r) => r.severity === 'degraded');
    const warn = rows.filter((r) => r.severity === 'at-risk');
    res.json({
      rows,
      stopped: bad.length,
      at_risk: warn.length,
      /* One surface refused, the channel still delivering. Counted separately
         because it is neither an emergency nor nothing: there IS a feed that
         is not arriving, and there is no data loss to chase. */
      degraded: degraded.length,
      degraded_rows: degraded.map((r) => ({ label: label(r),
        provider: r.provider, fleet_id: r.fleet_id, state: r.state,
        surface: r.surface, detail: r.detail })),
      missing: rows.filter((r) => r.severity === 'missing').length,
      /* One sentence the banner can print without the page having to compose
         it, so every surface that shows this says the same thing. */
      /* A moved endpoint is counted here so the page can name the OTHER
         errand: "stopped working" sends somebody to re-capture a credential,
         and for these rows the credential is not what is wrong. */
      moved: rows.filter((r) => r.state === 'moved').length,
      /* Counted the same way and for the same reason: a page that wants to say
         "one of these is a permission, not a password" needs the number. */
      unentitled: rows.filter((r) => r.state === 'unentitled').length,
      blocked: rows.filter((r) => r.state === 'blocked').length,
      /* Every errand present among the stopped rows, with the rows that carry
         it — so a caller composing its own sentence does not have to know the
         vocabulary, and a state added to SEVERITY_OF without a clause here is
         visible as an errand nobody named. */
      errands: Object.entries(ERRANDS)
        .map(([state, e]) => ({ state, noun: e.noun,
          count: bad.filter((r) => r.state === state).length,
          rows: bad.filter((r) => r.state === state).map(label) }))
        .filter((e) => e.count > 0),
      headline: bad.length
        ? ((() => {
          const only = Object.keys(ERRANDS).find((st) => bad.every((r) => r.state === st));
          const detail = bad.map((r) => `${label(r)} — ${r.detail || 'refused'}`).join('; ');
          if (only) return `${ERRANDS[only].whole(bad.length)}: ${detail}`;
          const parts = Object.entries(ERRANDS)
            .map(([st, e]) => [bad.filter((r) => r.state === st).length, e])
            .filter(([n]) => n > 0).map(([n, e]) => e.part(n));
          /* EVERY row accounted for, or only some.
             ─────────────────────────────────────────────────────────────
             This went straight to the generic "stopped working and have to be
             replaced" lead whenever more than one errand was present — and
             production's own pair on 2026-09-07 is two DIFFERENT errands,
             Bolt unentitled and Yango blocked, neither of which can be
             replaced. So the sentence written to stop the banner giving the
             wrong instruction gave it, on the only case it was written for.

             When every stopped row has an errand, none of them is a
             replacement and the lead must not claim one. The generic lead is
             for a genuine MIX, where some row really is a dead credential. */
          const covered = parts.length
            ? bad.filter((r) => ERRANDS[r.state]).length : 0;
          if (covered === bad.length) {
            return `${bad.length === 1 ? 'A surface is' : `${bad.length} surfaces are`} collecting `
              + `nothing, and ${bad.length === 1 ? 'it is not' : 'none of them is'} a credential to `
              + `replace — ${parts.join('; ')}: ${detail}`;
          }
          /* "and have to be replaced" is stated rather than implied, because
             that is the errand this lead is claiming and the clauses after it
             are the exceptions to it. A lead that only says "stopped working"
             leaves the reader to guess which afternoon's work it means. */
          return `${bad.length === 1 ? 'A credential has' : `${bad.length} credentials have`} stopped `
            + `working and ${bad.length === 1 ? 'has' : 'have'} to be replaced`
            + (parts.length ? ` — except ${parts.join('; ')}` : '') + `: ${detail}`;
        })())
        : warn.length
          ? `${warn.length === 1 ? 'A source has' : `${warn.length} sources have`} not collected recently: `
            + warn.map((r) => `${label(r)}, last run ${r.run_age_h}h ago`).join('; ')
          : null,
      /* Absent, not healthy. A brand-new database has recorded nothing, and
         "every credential is fine" is not a claim an empty table supports. */
      observed: rows.length > 0,
    });
  }));
}

/** "Uber · Egari (UBER_WEB_COOKIE_EGARI)" — the provider, the fleet it fails
    for, and the key a person has to go and replace. */
function label(r) {
  const fleet = r.fleet_id && r.fleet_id !== '*'
    ? ` · ${r.fleet_id[0].toUpperCase()}${r.fleet_id.slice(1)}` : '';
  return `${r.provider}${fleet} (${r.credential})`;
}
