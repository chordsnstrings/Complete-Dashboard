/* Per-driver detail API.
   ─────────────────────────────────────────────────────────────────────────
   One human can be several records: Uber issues a UUID, Yango a different id,
   Bolt a third, and the hotel channel a fourth — all for the same person. The
   only thing they share is the name they are entered under, and even that is
   inconsistent ("Najeeb Ullah Khan" vs "Najeeb Ullah Khan Khan"). So every
   endpoint here starts by resolving the requested id into the *set* of records
   that plausibly belong to one driver, and answers over that whole set.

   Resolution is deliberately conservative: we match on an exact normalised
   name, never on a fuzzy score, because merging two real people into one page
   is a worse failure than showing the same person twice. */

import { win, winDays } from './window.js';
/* One definition of an online span, shared with /api/supply/heat and with the
   rollup that writes driver_day.online_min. Four private copies of it had
   drifted into the same defect at once; see the module header for the
   measurement. */
import { onlineSpansSql } from './online_span_sql.js';
import { fleetIncome, COMPLETED_SQL } from './income_sql.js';
/* The alerts-per-distance rule, shared with the fleet headline and both
   economics ledgers so this page cannot disagree with the tables that link
   to it. See api/alert_coverage_sql.js for the rule and its assumption. */
import { alertCoverage, alertRate, alertRateReason, drivingCount,
  deviceCount, isDeviceFault, DEVICE_FAULT_SQL } from './alert_coverage_sql.js';
import { areaOf } from './analytics_routes.js';
/* A pg DATE, as the day it holds. Imported rather than re-typed: it is not a
   cycle (src/sources/ledger.js reaches only src/db.js and src/log.js, and
   nothing under src/ imports this file), api/day_routes.js and
   api/economics_routes.js already read this same function, and a fourth local
   copy of a rule this product has now got wrong in four places is a fourth
   place to get it wrong. */
import { isoDay } from '../src/sources/ledger.js';
/* The collector's own schedule, so a page can say how long a still-filling day
   has to wait rather than asking the reader to take the gap on trust. Imported
   the same way api/supply_routes.js imports it; src/config.js reaches only the
   settings table, so there is no cycle. */
import { config } from '../src/config.js';
import { isAdmin } from './admin_gate.js';
import { IDENTITY_DOCS, stripIdentity, withheldNote, withPhotos, photoHref } from './redact.js';
/* The ninety identities the register applies, id to id — see api/identity_map.js
   for the measurement behind each and why this is a LIST and not a rule. The
   stored person_key already carries them (sql/schema_v53.sql generates it from
   the same module), so every aggregate here folds them together on its own.
   These two helpers are for the parts of a driver page that are not an
   aggregate: resolving the id in the URL, and the directory's per-row fold,
   where a record with no work in the window has no stored key to fold on. */
import { canonicalName, mergedIds, mergedNames, mergedPlatforms, ALIAS_KEY,
  personOf } from './identity_map.js';
/* The links a roster proved rather than a person checked: two records, two
   channels, one phone number. Consulted AFTER the register, so a human's
   decision always wins — see api/identity_links.js. */
import { identityLinks, linkedKey, linkedName, linkedIds, linkedByName } from './identity_links.js';

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/* "every N hours", read off a cron expression's hour field, or null when the
   expression says something a sentence cannot summarise. Only the two shapes
   the product actually uses are answered — a stepped hour field and a bare
   one —
   because a half-right summary of a complicated schedule is worse than none:
   the caller drops the clause entirely when this returns null. */
export function cronEveryHours(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length < 5) return null;
  const step = /^\*\/(\d{1,2})$/.exec(f[1]);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 24 ? n : null;
  }
  return f[1] === '*' ? 1 : null;
}

/* Some feeds duplicate a name part ("Khan Khan", "Gul Gul"). Collapsing an
   immediately-repeated word is safe — it never merges distinct names.

   ANY repeated adjacent word, not only the final pair. This collapsed the last
   two words only, while the SQL fold in api/server.js collapses every repeat
   wherever it falls — so "Sajid Gul Gul Muhammad" folded to itself here and to
   "Sajid Gul Muhammad" there, and the driver directory and the driver ranking
   reported different headcounts for the same fleet on the same window. Two
   implementations of one identity rule is two answers to "how many drivers do
   we have"; test/consistency.test.mjs now runs both folds over the same names
   and requires the same answer. */
function canonName(s) {
  const parts = norm(s).split(' ').filter(Boolean);
  const out = [];
  for (const w of parts) if (out[out.length - 1] !== w) out.push(w);
  return out.join(' ');
}

/* Two folds, deliberately different, and it matters which is which.

   CANON is the plain fold: trim, collapse runs of whitespace, lowercase. It is
   the *identity* fold — it is what synthesises a stable key for a driver the
   provider names but never gives an id, and the same expression is used in
   custody.js, so the person keys identically in vehicle_driver_day and here.

   canonName() above is the looser *alias* fold, used only to decide that two
   ids belong to one human. It additionally collapses a duplicated surname,
   which is right for grouping and wrong for a key: fold the key that way and a
   feed that starts spelling somebody "Khan Khan" silently renames their id.

   canonSql() is CANON in JS, so a key built in Node matches one built in
   Postgres. Never build a name: key with canonName(). */
const CANON = (col) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
const canonSql = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const nameKey = (s) => `name:${canonSql(s)}`;
const isNameKey = (id) => String(id || '').startsWith('name:');

export function driverRoutes(app, { q, wrap, endOfDay }) {

  /* Resolve `?id=` (a platform driver id, or a synthesised name: key) or
     `?name=` into every record for that person. Returns null when nothing
     matches, so callers can 404 honestly. */
  async function resolve(req) {
    const id = req.query.id || null;
    const nameQ = req.query.name || null;
    let seed = null;
    /* A name: key is not a provider id and will never be found in a
       driver_ext_id column — looking it up there 404s a person the directory
       just linked to. It carries its own name, so resolve it directly. */
    if (id && isNameKey(id)) {
      const want = id.slice(5);
      /* person_key rather than the fold. Identical value — sql/schema_v20.sql
         stores this exact expression — but a stored column has an index and a
         computed one cannot, so this was a full scan of 175,000 rows folded
         twice on every driver page, before the page had asked for anything. */
      [seed] = await q(
        `SELECT NULL::text AS driver_ext_id, driver_name, platform FROM trip
         WHERE person_key = $1 AND coalesce(btrim(driver_ext_id), '') = ''
         ORDER BY requested_at DESC LIMIT 1`, [want]);
      if (!seed) [seed] = await q(
        `SELECT NULL::text AS driver_ext_id, driver_name, platform FROM trip
         WHERE person_key = $1 ORDER BY requested_at DESC LIMIT 1`, [want]);
      if (!seed && !nameQ) return null;
    } else if (id) {
      [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 AND driver_name IS NOT NULL ORDER BY requested_at DESC LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, full_name AS driver_name, platform FROM driver_compliance
         WHERE driver_ext_id = $1 LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM driver_performance
         WHERE driver_ext_id = $1 ORDER BY period_end DESC LIMIT 1`, [id]);
      // last resort: the id exists on trips but nothing ever gave it a name
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 ORDER BY requested_at DESC LIMIT 1`, [id]);
      /* …unless the merge register knows it. The Bolt record in it holds no
         trip, no compliance row and no performance row — a platform standing
         is its whole existence — so every seed above misses it and the page
         404s a person the directory links to. */
      if (!seed && !nameQ && !canonicalName(id)) return null;   // unknown id — say so rather than answering emptily
    }
    /* A verified duplicate answers under the name of the record it duplicates,
       which is what makes the resolution symmetric: person_key on the trip
       table is already the survivor's key for BOTH records, so folding the
       requested id onto the survivor's name here means opening either one
       finds both. Without it, opening the Yango record searched for "khalil
       aliyan", matched no trip row (they now key as "aliyan khalil") and
       showed a 429-day veteran as a 20-trip newcomer — which is exactly what
       production does today. */
    /* The register, then the roster's proof, then whatever the seed row said.
       ─────────────────────────────────────────────────────────────────────
       Same precedence as the directory fold and for the same reason. Opening
       the Uber record for "Muhammad Khalid" has to land on the person the
       hotel roster calls MUHAMMAD KHALIFA AFZAL KHALID, or the page shows one
       of his two accounts and the directory shows both — two answers to one
       question, which is worse than either being wrong. */
    const links = await identityLinks(q);
    const name = canonicalName(id) || (id && linkedName(links, id)) || seed?.driver_name || nameQ;
    if (!name) return id
      ? { id, name: null, ids: [id], keys: [id], platforms: seed ? [seed.platform] : [] }
      : null;

    /* Every id sharing the canonical name, across all sources that carry names.
       Rows with no id contribute the synthesised name: key rather than being
       dropped, so a person the provider names but never numbers still resolves
       to something the trip queries below can match. */
    /* Matched in SQL, not in Node. This selected EVERY row of trip, folded the
       name on each, shipped all 175,000 to the process and then kept the
       handful that matched — on every one of the eight or so requests a driver
       page makes. The trip side is now an indexed lookup on person_key, which
       stores the same fold; the other two tables are small enough that folding
       them in place costs nothing, and they have no such column. */
    const want = canonName(name);
    const alias = await q(
      `SELECT DISTINCT platform, driver_ext_id, driver_name FROM (
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || person_key) AS driver_ext_id,
                driver_name FROM trip WHERE person_key = $1
         UNION ALL
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('full_name')}), full_name
           FROM driver_compliance WHERE ${CANON('full_name')} = $1
         UNION ALL
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')}), driver_name
           FROM driver_performance WHERE ${CANON('driver_name')} = $1
       ) s WHERE coalesce(btrim(driver_name), '') <> ''`, [want]);
    /* flatMap through the register, so the partner id is present whichever
       side was asked for. It adds nothing at all for the other 392 records —
       mergedIds returns the id it was given — and it is what carries a record
       that has no row in ANY of the three tables above (the Bolt standing)
       into the account list of the person it belongs to. */
    /* …and through the roster's links as well as the register's merges. The
       partner id is what carries a record the name search above cannot reach:
       the whole point is that the two channels file different names, so
       matching on the canonical name finds one side and not the other. */
    const ids = [...new Set([...alias.map((a) => a.driver_ext_id), ...(id ? [id] : [])]
      .filter(Boolean)
      .flatMap(mergedIds)
      .flatMap((x) => linkedIds(links, x)))];
    if (!ids.length) return null;

    /* Two different lists, and conflating them was a bug in both directions.

       `ids` is what this person's ACCOUNTS are — the provider ids they hold. It
       is shown to a reader ("three accounts across two platforms"), so a
       synthesised key has no business in it.

       `keys` is what their ROWS can be MATCHED by, which is a superset: the
       same ids, plus the synthesised name key for every spelling they appear
       under. A driver who works Uber under an id and the hotel channel without
       one carries both forms, and matching on ids alone left their hotel work
       off their own page while the fleet totals still counted it. A key that
       matches nothing costs one comparison. */
    const keys = [...new Set([...ids,
      ...alias.map((a) => nameKey(a.driver_name)), nameKey(name),
      /* Both spellings of a merged person, for rows the provider named
         without numbering — a key that matches nothing costs one comparison. */
      ...ids.flatMap(mergedNames).map(nameKey)].filter(Boolean))];
    // the longest spelling is usually the fullest one; prefer it for display
    const display = alias.map((a) => a.driver_name).sort((a, b) => b.length - a.length)[0] || name;
    return { id: id || ids[0], name: display, ids, keys,
      /* The register's channels as well as the measured ones: the Bolt half of
         one merged pair files no trips at all, so a list built from work alone
         would omit the channel carrying the fact the operator needs — that the
         fleet deactivated that account. */
      platforms: [...new Set([...alias.map((a) => a.platform), ...ids.flatMap(mergedPlatforms)])] };
  }

  /* The person key: a provider id where there is one, the synthesised name: key
     where there is not. Every query over trip/trip_norm keys on this, never on
     the raw column — keyed raw, a driver the provider names without an id has
     no matchable rows and every panel on their page comes back empty while the
     directory row that linked there says they drove. */
  const PKEY = `coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')})`;

  /* The window, as Dubai calendar days — the same expression trip_norm.local_day
     is built from (sql/schema_v18.sql:67) and driver_day is keyed on.

     This was `requested_at BETWEEN $1 AND $2`, a raw timestamptz bound in a UTC
     session, and it cost this page the first four hours of every window. Dubai
     is UTC+4, so the calendar day 2026-08-01 begins at 2026-07-31T20:00Z; a
     bound starting at 2026-08-01T00:00Z drops 00:00–04:00 Dubai on the window's
     first day and picks up the same slice of the day AFTER the last one.

     It was not a rounding error. Reconciled day by day against the trip record
     for one driver's August, /api/driver/daily reported 283 trips where the
     trip list and driver_day both reported 285 — every day agreeing except the
     first, which showed 4 against 6. The same page therefore disagreed with the
     stored per-day record it is drawn beside, and with the fleet totals, which
     have used local_day all along.

     api/server.js carries the same note for the window's END (DAYWIN), and the
     driver directory below fixed its own copy of this bug; the detail page kept
     it because `win()` widens the upper bound to 23:59:59.999 and so LOOKS
     right. The lower bound is the half nothing widened.

     `$2::date` truncates that widened upper bound back to its day, which is
     what a day-grain comparison wants. */
  const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

  // Shared trip predicate: any of this person's keys, over the window.
  // `$1..$2` window, `$3` key array — keep this argument order in every query.
  const TW = `${PKEY} = ANY($3) AND ${DAYWIN('requested_at')}`;

  // Wrap a handler so it resolves the driver first and 404s cleanly when unknown.
  const withDriver = (fn) => wrap(async (req, res) => {
    const d = await resolve(req);
    if (!d) return res.status(404).json({ error: 'driver not found' });
    // The MATCH set, not the account list — see resolve() above.
    return fn(req, res, d, [...win(req), d.keys]);
  });

  /* ── directory: every driver we know of, one row each ─────────────────
     Four things were wrong here and all four made the page describe the fleet
     as busier and cleaner than it is:

       - it was built FROM the trip table, so a driver who took nothing in the
         window had no row at all — under a panel headed "All drivers". Sixty-
         four of the people missing that way had an expired licence, which is
         exactly who an operator opens this page to find. The sibling vehicle
         directory does the opposite on purpose and says so.
       - the window was bound as a raw timestamptz in a UTC session, so it
         dropped the Dubai 00:00-04:00 slice of the first day and added a
         phantom one after the last — and the /api/vehicles panel on the same
         screen used Dubai days, so the two disagreed about the same plate.
       - the fold summed trips and kilometres but never recomputed
         completion_pct, so a person carried whichever account happened to be
         listed first — presented as that human's completion rate.
       - `days` took the MAX across a person's accounts rather than the union,
         so days worked on one platform and not another were discarded.

     Completion is over trip_norm.outcome, not status='completed': Bolt says
     'finished', and testing for 'completed' scored every completed Bolt trip
     as a failure. */
  /* Every link the roster proved, with the evidence, so none of them is a
     merge on trust.
     ─────────────────────────────────────────────────────────────────────────
     The register in api/identity_map.js is a list a person checked pair by
     pair, and it is right to be. This is a rule that ran, so it owes the reader
     more: which two records, on which two channels, under which phone number's
     last four digits, and whether the names could have joined them without it.

     It also reports what it could NOT see, which is the half a page built on
     this must print. Measured 2026-09-07: 166 of 434 directory rows carry no
     phone on any record — 93 Bolt-only, 51 Uber-only, 80,443 trips between
     them — and this rule is blind to every one. A page that lists sixty links
     and says nothing about that reads as "the roster is now clean". */
  app.get('/api/drivers/identity-links', wrap(async (req, res) => {
    const links = await identityLinks(q);
    /* The reach, counted against the ACCOUNTS THE PRODUCT KNOWS — not against
       the roster.
       ─────────────────────────────────────────────────────────────────────
       The first version of this counted driver_compliance rows with a phone
       against driver_compliance rows, which is 289 of 289 and reported
       "0 records it cannot see". That is the most reassuring possible number
       and it is meaningless: a roster row is by definition a record we hold
       contact details for, so the question answers itself.

       The figure that matters is how many driver ACCOUNTS this rule cannot
       see at all. driver_lifetime carries one row per account the product has
       ever counted work for — Bolt records included, and Bolt files no phone
       anywhere — so the difference is the real blind spot. Measured
       2026-09-07 from the directory: 166 of 434 people carried no phone on any
       of their records, 93 of them Bolt-only, with 80,443 trips between them. */
    const [cov] = await q(
      `WITH phoned AS (
         SELECT DISTINCT driver_ext_id FROM driver_compliance
          WHERE phone IS NOT NULL AND btrim(phone) <> ''
            AND driver_ext_id IS NOT NULL AND btrim(driver_ext_id) <> ''
       ),
       accounts AS (
         SELECT driver_ext_id FROM driver_lifetime
          WHERE driver_ext_id IS NOT NULL AND btrim(driver_ext_id) <> ''
         UNION
         SELECT driver_ext_id FROM driver_platform_state
          WHERE driver_ext_id IS NOT NULL AND btrim(driver_ext_id) <> ''
       )
       SELECT (SELECT count(*)::int FROM driver_compliance) AS roster_rows,
              count(*)::int AS accounts,
              count(*) FILTER (WHERE p.driver_ext_id IS NOT NULL)::int AS with_phone
         FROM accounts a LEFT JOIN phoned p USING (driver_ext_id)`);
    /* The rejected ones are returned SEPARATELY rather than filtered away: an
       operator who overruled the rule should be able to see that they did, and
       a link that keeps coming back is a conversation the page should carry. */
    const rejected = await q(
      `SELECT alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
              canonical_name, evidence, phone_tail, rejected_reason, last_seen_at
         FROM driver_identity_link WHERE rejected ORDER BY canonical_name NULLS LAST`);
    /* Which of these the register has already taken.
       ─────────────────────────────────────────────────────────────────────
       Forty-five of the pairs this rule found were promoted into
       api/identity_map.js and are now in the stored person_key column, and a
       page that lists them beside the ones that are not says the same thing
       about two rows that behave differently. A promoted pair is folded by
       every rollup in the product and CANNOT be undone from here — rejecting
       it takes it off this list and leaves the records folded — so the row has
       to say so, and applies_note below has to stop claiming otherwise. */
    const promoted = links.rows.filter((l) =>
      ALIAS_KEY.has(l.alias_ext_id) || ALIAS_KEY.has(l.canonical_ext_id)).length;
    res.json({
      links: links.rows.map((l) => ({
        ...l,
        promoted: ALIAS_KEY.has(l.alias_ext_id) || ALIAS_KEY.has(l.canonical_ext_id),
      })),
      rejected,
      promoted,
      coverage: {
        roster_rows: cov?.roster_rows ?? 0,
        accounts: cov?.accounts ?? 0,
        with_phone: cov?.with_phone ?? 0,
        without_phone: Math.max(0, (cov?.accounts ?? 0) - (cov?.with_phone ?? 0)),
      },
      basis_note: 'Two records the roster gave the same phone number, on two different '
        + 'channels. A number on three records links nobody, and neither does one that '
        + 'appears twice within a single channel — both identify a handset rather than a '
        + 'person, and being wrong in that direction merges two people\u2019s work and money.',
      precedence_note: 'A person\u2019s decision wins over the rule in both directions. Pairs '
        + 'somebody has already looked at and refused never enter this table, and a link '
        + 'rejected here survives every later run.',
      reach_note: 'This can only see a record that carries a phone number. Bolt files none at '
        + 'all, and reaches Uber only because Bolt and the hotel channel file the same full '
        + 'name and the existing name fold already joins those two.',
      applies_note: 'A link folds the driver directory and the driver pages on the next '
        + 'request. On its own it does not move person_key, which is a stored column, so a '
        + 'rollup that groups by it counts the two records apart until the link is promoted '
        + 'into api/identity_map.js by hand. The rows marked promoted have been: they are in '
        + 'the stored column, every rollup folds them, and rejecting one here takes it off '
        + 'this list without unfolding the records \u2014 that needs an edit to '
        + 'api/identity_map.js and a regenerated sql/schema_v53.sql.',
    });
  }));

  app.get('/api/drivers/directory', wrap(async (req, res) => {
    /* range, not winDays. This read from/to and nothing else, so the platform
       and fleet chips above the directory changed none of its 359 rows: with
       Bolt selected the page stated that 118 people drove on Bolt and plotted
       80 of them, on a channel with no trip anywhere in the database, and
       &fleet=egari came back byte-identical to unfiltered on a two-fleet
       operator.

       A filter narrows the POPULATION as well as the work. With a platform
       selected, "everyone we know of" is everyone who drove on that platform
       in the window or holds a compliance or standing record on it — not
       everyone in the fleet with their trips zeroed, which would report the
       whole roster as idle on Bolt. */
    /* range() lives in server.js and is not among this module's injected deps;
       it is winDays plus the two chips, so it is spelled out here rather than
       threading a new dependency through every route module. */
    const [from, to] = winDays(req);
    const platform = req.query.platform || null;
    const fleet = req.query.fleet || null;
    const P = [from, to, platform, fleet];
    const filtered = !!(platform || fleet);
    /* "Has this person ever driven, and when last" is the one question here
       with no window, so answering it live means grouping the entire trip
       history on every request — two hundred and fifteen thousand rows to
       decorate eight hundred directory rows. driver_lifetime holds it,
       rebuilt after every collection from the SAME SQL that is the fallback
       below, so the two cannot disagree; the fallback runs on a fresh
       database or a deploy that lands before the first rollup.

       A seq-scan predicate on purpose, in both. Written as
         WHERE person_key IS NOT NULL AND person_key <> ''
       it matches the partial index's own predicate exactly, so the planner
       chose an index scan and then fetched the heap row for essentially every
       row in the table: this endpoint went from 4.3s to 41s. The projection
       still uses person_key, which is where the saving actually was. */
    const lifetimeReady = (await q('SELECT 1 FROM driver_lifetime LIMIT 1')).length > 0;
    /* The placeholder licence date, detected the way /api/compliance/drivers
       and src/insights.js already detect it: one date on at least half the
       dated rows, over at least five of them, is what this source writes when
       the field was never filled in.
       ─────────────────────────────────────────────────────────────────────
       The directory did not know about it. All 77 rows carrying licence number
       123456 and the identical date 2026-01-01 were served with a past expiry,
       and the page counted them into "77 with an expired licence" and painted
       red EXPIRED pills — while /api/compliance/drivers, describing the same
       people, reported expired: 0. Two pages of one product disagreeing about
       whether 77 named people may legally drive. */
    const [phRow] = await q(
      `SELECT to_char(licence_expires, 'YYYY-MM-DD') AS d, count(*)::int n,
              (SELECT count(*)::int FROM driver_compliance WHERE licence_expires IS NOT NULL) AS with_date
       FROM driver_compliance WHERE licence_expires IS NOT NULL
       GROUP BY licence_expires ORDER BY n DESC LIMIT 1`);
    const placeholderDate = phRow && phRow.with_date && phRow.n >= 5
      && phRow.n / phRow.with_date >= 0.5 ? phRow.d : null;
    /* The lifetime CTE carries identity now, not just counts.
       ─────────────────────────────────────────────────────────────────────
       Measured on production over thirty days: 361 rows, 244 of them with no
       fleet, no channel list and no vehicle — one of those people has 2,393
       trips on record. Every one of those columns was read from the WINDOW's
       trips, and a person who last drove in June has none. A driver's fleet is
       not a fact about a date range, so it is answered over the whole history
       and used only where the window has nothing to say. The fallback below
       computes the same three columns, so a fresh database behaves
       identically. */
    const everSql = lifetimeReady
      ? `SELECT driver_ext_id, driver_name, last_ever, lifetime,
                last_fleet, platforms AS ever_platforms, last_plate
           FROM driver_lifetime`
      : `SELECT coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || person_key) AS driver_ext_id,
                max(driver_name) AS driver_name,
                max(requested_at) last_ever, count(*)::int lifetime,
                (array_agg(fleet_id ORDER BY requested_at DESC NULLS LAST)
                   FILTER (WHERE fleet_id IS NOT NULL))[1] AS last_fleet,
                array_agg(DISTINCT platform)
                  FILTER (WHERE platform IS NOT NULL AND platform <> '') AS ever_platforms,
                (array_agg(plate ORDER BY requested_at DESC NULLS LAST)
                   FILTER (WHERE plate IS NOT NULL AND btrim(plate) <> ''))[1] AS last_plate
           FROM trip WHERE driver_name IS NOT NULL AND btrim(driver_name) <> '' GROUP BY 1`;
    const rows = await q(
      `WITH ever AS (${everSql}),
       work AS (
         /* The synthesised key from the STORED fold. Written with the fold
            inline it ran two nested regexes over every row in the window as
            the GROUP BY key, which is nineteen twentieths of this CTE's cost
            (schema_v20 measured 2,434ms against 129ms) — and it is the same
            value, because person_key IS that expression, generated and
            stored. The filter still tests driver_name: matching the partial
            index's own predicate is what took this endpoint from 4.3s to 41s. */
         SELECT coalesce(nullif(btrim(n.driver_ext_id), ''),
                         'name:' || bt.person_key) AS driver_ext_id,
                max(n.driver_name) AS work_name,
                /* The STORED fold of the name this person drove under, carried
                   out so the fold below can key on it. See the note at the
                   fold. */
                max(bt.person_key) AS person_key,
                min(n.fleet_id) fleet_id,
                count(*) FILTER (WHERE n.is_booking)::int trips,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome IS NOT NULL)::int bookable,
                count(DISTINCT n.local_day)::int days,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE n.has_fare)::int priced_trips,
                max(n.requested_at) last_trip, min(n.requested_at) first_trip,
                array_agg(DISTINCT n.platform) platforms,
                mode() WITHIN GROUP (ORDER BY n.plate) AS plate
         FROM trip_norm n JOIN trip bt ON bt.platform = n.platform AND bt.external_id = n.external_id
         -- Grouped on the SAME synthesised key as the ids CTE below. Keyed on
         -- the raw column, a driver named without an id had an ids row and no
         -- work to join to it, so they appeared with a permanent zero, which is
         -- worse than absent: it reads as somebody who did nothing.
         WHERE n.local_day BETWEEN $1::date AND $2::date
           AND coalesce(btrim(n.driver_name), '') <> ''
           AND ($3::text IS NULL OR n.platform = $3)
           AND ($4::text IS NULL OR n.fleet_id = $4)
         GROUP BY 1
       ),
       ids AS (
         /* Everyone we know of, from any source, whether or not they drove.
            A name with no id is still a person: the id is synthesised from the
            canonical name so they key identically here, in the work CTE below,
            and in vehicle_driver_day. Requiring an id here made those people
            vanish from the directory entirely.

            The trip branch reads the CTE above rather than scanning the table
            a second time. The who CTE takes max(driver_name) per key, so
            collapsing the several names a key may carry to their max here
            leaves that maximum unchanged. */
         /* The all-time branch carries no platform or fleet — driver_lifetime
            is keyed on the person alone — so under a filter it would readmit
            the whole roster with its work zeroed, which reads as "everybody is
            idle on Bolt". Under a filter the population is exactly the people
            the three filterable sources name. */
         SELECT driver_ext_id, driver_name FROM ever
           WHERE $3::text IS NULL AND $4::text IS NULL
         UNION
         SELECT w.driver_ext_id, w.work_name FROM work w
         UNION
         SELECT coalesce(nullif(btrim(driver_ext_id), ''),
                         'name:' || ${CANON('full_name')}), full_name FROM driver_compliance
           WHERE coalesce(btrim(full_name), '') <> ''
             AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
         UNION
         SELECT coalesce(nullif(btrim(driver_ext_id), ''),
                         'name:' || ${CANON('full_name')}), full_name FROM driver_platform_state
           WHERE coalesce(btrim(full_name), '') <> ''
             AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
       ),
       who AS (
         SELECT driver_ext_id, max(driver_name) AS driver_name FROM ids GROUP BY 1
       ),
       /* What actually reached the fleet for this person's work.
          ─────────────────────────────────────────────────────────────────────
          The revenue column beside this one is sum(trip.price), and the Uber
          trip export has no fare column at all (sql/schema_v18.sql:73). Uber is
          236,000 of the fleet's 253,000 trips, so on a seven-day window 101
          people drove and 21 had a fare — eighty rows of a table whose job is
          to rank people showed a dash in the only money column it had.

          The money exists; it is simply not a fare. driver_payout_day carries
          what each account was PAID, and that is what an operator ranking
          drivers is actually asking about. Keyed on the account id and summed
          over the window's days, so overlapping report periods cannot double
          count — that resolution already happened when the table was built
          (sql/schema_v23.sql). */
       pay AS (
         SELECT driver_ext_id,
                round(sum(earnings)::numeric, 0) AS payout,
                count(DISTINCT day)::int AS payout_days
           FROM driver_payout_day
          WHERE day BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1
       ),
       /* One money column that answers for everybody.
          ─────────────────────────────────────────────────────────────────────
          The two columns beside it each answer for about half the roster and
          for different halves: revenue is the fares on the trips, which 44 of
          119 active drivers have, because Uber's export carries no fare at all;
          payout is what the platform paid, which 96 have. Between them nobody
          is missing — and a reader ranking drivers is reading one column for
          one person and a different, incomparable one for the next.

          driver_day.money is the resolution this fleet already made: per
          platform, the statement's net where a channel filed one and its fares
          where it did not, then summed (src/rollup.js). money_period_days
          travels with it because most of it is a weekly statement divided
          across its days, and the coarsest window on a person's days is what
          limits what can be said about their total.

          Keyed on the account and summed: the money lands on ONE account per
          person-day by design (the owner CTE in src/rollup.js), so a person
          holding two accounts is added, not doubled. */
       dmoney AS (
         SELECT driver_ext_id,
                round(sum(money)::numeric, 0) AS money,
                count(*) FILTER (WHERE money IS NOT NULL)::int AS money_days,
                CASE WHEN bool_or(money IS NOT NULL AND money_period_days IS NULL) THEN NULL
                     ELSE max(money_period_days) END AS money_period_days,
                CASE WHEN count(DISTINCT money_source) FILTER (WHERE money_source <> 'none') > 1
                     THEN 'mixed'
                     ELSE max(money_source) FILTER (WHERE money_source <> 'none') END AS money_source
           FROM driver_day
          WHERE day BETWEEN $1::date AND $2::date
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1
       )
       /* The lifetime figures come from the CTE at the top of this statement:
          the last trip EVER, so "has not driven in this window" and "has never
          driven" are different rows rather than the same blank — and keyed on
          person_key rather than the fold, because that scan is unbounded and
          folding 175,000 names per request is what the stored, indexed column
          exists to avoid. */
       SELECT who.driver_ext_id, who.driver_name, w.person_key,
              coalesce(w.trips, 0) AS trips, coalesce(w.completed, 0) AS completed,
              coalesce(w.bookable, 0) AS bookable, coalesce(w.days, 0) AS days,
              w.km, w.revenue, coalesce(w.priced_trips, 0) AS priced_trips,
              pay.payout, coalesce(pay.payout_days, 0) AS payout_days,
              dm.money, coalesce(dm.money_days, 0) AS money_days,
              dm.money_period_days, dm.money_source,
              w.last_trip, w.first_trip,
              /* Window first, whole history second. The window answer is the
                 one that describes THIS range; the lifetime answer exists so
                 that a person the range does not cover is still identified
                 rather than shown as four blanks under their own name.
                 ever_* is never used to overwrite a window value. */
              coalesce(w.plate, ev.last_plate) AS plate,
              /* …and the books, third. 129 of the people still blank after
                 the history fallback have never driven at all, so no trip can
                 name their fleet — but every one of them holds a standing or a
                 compliance record, and BOTH of those tables carry fleet_id
                 (this query already filters on it). A person on the books with
                 no fleet beside their name is the page failing to read a
                 column it is already joined to. */
              coalesce(w.fleet_id, ev.last_fleet, dc.fleet_id, dps.fleet_id) AS fleet_id,
              coalesce(w.platforms, ev.ever_platforms, ARRAY[]::text[]) AS platforms,
              /* So a reader can tell a measurement from an identity: true
                 where these three describe work outside the window. */
              (w.trips IS NULL OR w.trips = 0) AND coalesce(ev.lifetime, 0) > 0
                AS identity_from_history,
              ev.last_ever, coalesce(ev.lifetime, 0) AS lifetime_trips,
              dc.state, dc.licence_expires, dc.rating,
              /* Whether this product HOLDS the person's photograph, so every
                 list that draws them can draw their face rather than two
                 letters.
                 ─────────────────────────────────────────────────────────────
                 Not dc.picture_url. That column holds what Uber returned: a
                 CloudFront URL signed for twelve hours, written weekly, and
                 therefore dead for about 93% of its life — measured on
                 production, 156 of them expired together on 4 September and
                 every one answered 403 behind an <img> that deletes itself.
                 A row in driver_photo means the bytes are on this origin, and
                 the address is built from the key rather than stored. This
                 reads two key columns and never an image.

                 dp.platform, not this row's platform. The first cut of this
                 built the address out of r.platform in the fold below — and
                 THIS select has no bare platform column at all. It has
                 platforms (an array), compliance_platform, state_platform;
                 the other three routes that draw a face happen to select a
                 scalar platform column, so they worked and this one silently handed
                 434 of 434 people a null. Measured on production after the
                 first real profile run: compliance 157 addresses, leaderboard
                 81, profile 1, directory 0.

                 Taking it from dp is also the correct source on its own terms.
                 The address must name the row the bytes are actually under; a
                 person with a hotel compliance record and an Uber photograph
                 would otherwise be sent to /api/driver/photo/hotel/<id>, which
                 is a 404 by construction. */
              dp.platform AS photo_platform,
              (dp.platform IS NOT NULL) AS has_photo,
              /* And why not, when there is a reason worth telling. Same shape
                 as dp: one row out however many are in. */
              pm.reason AS photo_absent_reason,
              (dc.licence_expires - now()::date) AS licence_days_left,
              ($5::text IS NOT NULL
               AND to_char(dc.licence_expires,'YYYY-MM-DD') = $5) AS licence_placeholder,
              /* Which platform said it. 241 of the people in this directory
                 have never driven — the panel exists for them — and every
                 column describing them was blank because the source platform
                 was dropped on the way out. A compliance record from Uber and
                 a standing from Bolt are different claims and the page could
                 not tell them apart, or say which one it was showing. */
              dc.platform AS compliance_platform,
              dps.state AS platform_state, dps.can_earn,
              dps.platform AS state_platform, dps.plate AS state_plate,
              /* The platform's own rating, which is what this column was always
                 meant to show. It read driver_compliance.rating — the hotel
                 channel's document register, which has never carried one — so
                 the column was empty on all 365 people and the sentence under
                 it blamed the channels. coalesce, not replace: if a channel
                 ever files one through compliance it still counts. */
              coalesce(dps.rating, dc.rating) AS platform_rating,
              dps.lifetime_trips AS platform_lifetime_trips,
              dps.is_banned, dps.compliance_status AS platform_compliance
       FROM who
       LEFT JOIN work w ON w.driver_ext_id = who.driver_ext_id
       LEFT JOIN pay ON pay.driver_ext_id = who.driver_ext_id
       LEFT JOIN dmoney dm ON dm.driver_ext_id = who.driver_ext_id
       LEFT JOIN ever ev ON ev.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_compliance dc ON dc.driver_ext_id = who.driver_ext_id
       /* LATERAL … LIMIT 1, not a plain join. driver_photo's key is
          (platform, driver_ext_id), so one account id can carry a row per
          channel — and a plain LEFT JOIN on the id alone would then return
          that person's work row TWICE, which the fold below adds up. A
          decoration that changes the trip count is not a decoration. One row
          out, however many are in. */
       LEFT JOIN LATERAL (
         SELECT p2.platform FROM driver_photo p2
          WHERE p2.driver_ext_id = who.driver_ext_id LIMIT 1) dp ON true
       LEFT JOIN LATERAL (
         SELECT m2.reason FROM driver_photo_miss m2
          WHERE m2.driver_ext_id = who.driver_ext_id LIMIT 1) pm ON true
       LEFT JOIN driver_platform_state dps ON dps.driver_ext_id = who.driver_ext_id
       ORDER BY coalesce(w.trips, 0) DESC, who.driver_name LIMIT 800`, [...P, placeholderDate]);

    /* Fold per-platform rows into one row per person, so the directory lists
       humans rather than accounts. Counts are carried through and the ratios
       are computed ONCE at the end — folding a pre-computed percentage keeps
       one account's number and calls it the person's. */
    /* Keyed on the STORED fold where the window has one.
       ─────────────────────────────────────────────────────────────────────
       This folded on canonName(who.driver_name), and who.driver_name is a max
       over four sources — the window's trips, the whole trip history, a
       compliance record and a platform standing. So the directory could be
       folding on a spelling from March while every other page in the product
       folds on the one from this window, and the two then answer "how many
       people drove" differently: 118 here against 119 on the overview, live,
       for the same fleet on the same days. Neither number was wrong and
       nothing on either page could explain the other.

       person_key is that same fold, generated and stored on the trip row
       (sql/schema_v20.sql), and it is what /api/kpis, the ranking and the
       vehicle pages count. Using it here makes the directory's headcount the
       overview's headcount by construction rather than by coincidence.

       canonName stays as the fallback for the people the window has no work
       for — a name on the books and nothing else — where there is no stored
       key to prefer. It is the same rule; test/consistency.test.mjs runs both
       over the same names and requires the same answer. */
    /* Read once for the whole fold, not once per row: sixty rows behind a
       thirty-second cache, and a per-row await would make the directory's cost
       depend on how many people the fleet has. */
    const links = await identityLinks(q);
    const byName = new Map();
    for (const r of rows) {
      /* The register first, then the stored fold, then the name.
         ─────────────────────────────────────────────────────────────────
         The stored key already carries the register, so for a person the
         window measured this changes nothing. It is the OTHER rows this is
         for: a record with no work in the window has no w.person_key and
         falls through to the name — and a great many of the merged records
         are exactly that. Fifty-six of the register's hundred and thirty
         alias ids have never filed a trip at all (Bolt standings and hotel
         ObjectIds carrying a phone number and nothing else), so without this
         the directory would still list them as separate people while every
         aggregate in the product counted them as one. */
      /* The register, then the roster's own proof, then the stored fold, then
         the name.
         ─────────────────────────────────────────────────────────────────
         The link layer sits SECOND on purpose. ALIAS_KEY is a list a person
         checked pair by pair against production; driver_identity_link is a
         rule that ran, and a rule must never overrule the person who looked.
         It sits above person_key because the stored key is the folded NAME,
         and the whole finding is that the two channels file different names
         for one human: "MUHAMMAD KHALIFA AFZAL KHALID" on the hotel roster and
         "Muhammad Khalid" on Uber, one phone number, 4,461 Uber trips reported
         under a row that showed 822. */
      const own = r.person_key || canonName(r.driver_name);
      const k = ALIAS_KEY.get(r.driver_ext_id)
        || linkedKey(links, r.driver_ext_id)
        /* …and the third record, which no link names because Bolt files no
           phone. It reaches the person through the name it shares with the
           alias — see byName in api/identity_links.js. */
        || linkedByName(links, own)
        || own;
      const cur = byName.get(k);
      if (!cur) {
        byName.set(k, { ...r, ids: [r.driver_ext_id], platforms: [...(r.platforms || [])],
          /* An unknown window on the SEEDING row counts the same as on any
             other: money_period_days is null both when nothing reported money
             and when what reported it could not say over what period, and only
             the second makes the person's total unstatable. */
          _grainUnknown: r.money != null && r.money_period_days == null,
          _ratingTrips: r.platform_rating != null ? (r.platform_lifetime_trips || 0) : -1,
          /* WHICH account carries the face. A person with a hotel record and an
             Uber one has two rows here and only Uber files a photograph, so the
             fold has to keep the account the picture is under rather than
             whichever row happened to seed the person. */
          _photo: r.has_photo ? { platform: r.photo_platform, id: r.driver_ext_id } : null,
          _photoMiss: r.has_photo ? null : (r.photo_absent_reason || null),
          _days: new Set() });
        continue;
      }
      cur.ids.push(r.driver_ext_id);
      if (!cur._photo && r.has_photo) cur._photo = { platform: r.photo_platform, id: r.driver_ext_id };
      if (!cur._photoMiss && r.photo_absent_reason) cur._photoMiss = r.photo_absent_reason;
      cur.trips += r.trips;
      cur.completed += r.completed; cur.bookable += r.bookable;
      cur.priced_trips += r.priced_trips;
      cur.lifetime_trips += r.lifetime_trips;
      cur.km = +(cur.km || 0) + +(r.km || 0);
      cur.revenue = +(cur.revenue || 0) + +(r.revenue || 0);
      /* Payouts DO sum across a person's accounts: two provider ids are two
         separate statements for the same human, and both reached the fleet. */
      if (r.payout != null) cur.payout = +(cur.payout || 0) + +r.payout;
      cur.payout_days = Math.max(cur.payout_days || 0, r.payout_days || 0);
      /* Summed across the person's accounts, like the payout beside it — the
         money is on one account per person-day by construction, so this adds
         rather than doubles. The GRAIN takes the coarsest of the accounts, and
         an account that cannot state its window makes the person's total
         unstated too: a figure that is partly a measurement and partly a share
         of a week is not a measurement. */
      if (r.money != null) cur.money = +(cur.money || 0) + +r.money;
      cur.money_days = (cur.money_days || 0) + (r.money_days || 0);
      if (r.money_period_days == null && r.money != null) cur._grainUnknown = true;
      else if (r.money_period_days != null) {
        cur.money_period_days = Math.max(cur.money_period_days || 0, r.money_period_days);
      }
      if (r.money_source && r.money_source !== cur.money_source) {
        cur.money_source = cur.money_source ? 'mixed' : r.money_source;
      }
      /* The platform's own opinion of the person, folded across their
         accounts. NOT averaged: two platforms rating the same human are two
         opinions on two scales and a mean of them is a number neither provider
         would recognise. The best-attested one wins — most lifetime trips
         behind it — and a ban on any account bans the person, because a
         constraint that holds anywhere holds. */
      if (r.platform_rating != null
          && (cur.platform_rating == null
              || (r.platform_lifetime_trips || 0) > (cur._ratingTrips || 0))) {
        cur.platform_rating = r.platform_rating;
        cur._ratingTrips = r.platform_lifetime_trips || 0;
      }
      if (r.platform_lifetime_trips != null) {
        cur.platform_lifetime_trips = Math.max(cur.platform_lifetime_trips || 0, r.platform_lifetime_trips);
      }
      if (r.is_banned === true) cur.is_banned = true;
      cur.platform_compliance = cur.platform_compliance || r.platform_compliance;
      cur.platforms = [...new Set([...cur.platforms, ...(r.platforms || [])])];
      if ((r.driver_name || '').length > (cur.driver_name || '').length) cur.driver_name = r.driver_name;
      if (r.last_trip > cur.last_trip) cur.last_trip = r.last_trip;
      if (r.first_trip && (!cur.first_trip || r.first_trip < cur.first_trip)) cur.first_trip = r.first_trip;
      if (r.last_ever > cur.last_ever) cur.last_ever = r.last_ever;
      cur.state = cur.state || r.state;
      cur.platform_state = cur.platform_state || r.platform_state;
      cur.compliance_platform = cur.compliance_platform || r.compliance_platform;
      cur.state_platform = cur.state_platform || r.state_platform;
      cur.state_plate = cur.state_plate || r.state_plate;
      if (cur.can_earn == null) cur.can_earn = r.can_earn;
      if (r.licence_days_left != null && (cur.licence_days_left == null || r.licence_days_left < cur.licence_days_left)) {
        cur.licence_days_left = r.licence_days_left; cur.licence_expires = r.licence_expires;
        cur.licence_placeholder = r.licence_placeholder;
      }
      cur._multiAccountDays = true;
    }

    /* Distinct working days across ALL of a person's accounts. Taking the max
       of pre-aggregated per-account counts discarded every day worked on one
       platform and not another. Only asked for the people who actually have
       more than one account. */
    const multi = [...byName.values()].filter((p) => p.ids.length > 1);
    if (multi.length) {
      const dayRows = await q(
        `SELECT ${PKEY} AS driver_ext_id, local_day FROM trip_norm
         WHERE local_day BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
           AND ${PKEY} = ANY($5)`,
        [from, to, platform, fleet, multi.flatMap((x) => x.ids)]);
      const idToPerson = new Map();
      multi.forEach((p) => p.ids.forEach((id) => idToPerson.set(id, p)));
      const days = new Map();
      for (const d of dayRows) {
        const person = idToPerson.get(d.driver_ext_id);
        if (!person) continue;
        const set = days.get(person) || new Set();
        /* isoDay, not String(d.local_day).slice(0, 10).
           ───────────────────────────────────────────────────────────────
           local_day is a bare DATE — sql/schema_v18.sql:67 builds it as
           `(requested_at AT TIME ZONE 'Asia/Dubai')::date` and the SELECT
           above does not wrap it in to_char — so node-postgres parses it into
           a JS Date, and those ten characters are "Fri Aug 14": the head of a
           Date toString, with the YEAR cut off. That exact string was measured
           coming out of this very column on /api/day, and the identical
           mistake shipped to production in src/sources/ledger.js and printed
           "covering days up to Fri Aug 21" on the Data-sources page.

           Nothing but the Set's SIZE escapes here — it becomes `days` on a
           /api/drivers/directory row — so the figure was right while the key
           was wrong, and right by luck rather than by construction: dropping
           the year leaves (weekday, month, day), which stays injective only
           while the window is short. Production on 2026-09-02 returned 395
           rows, 52 of them multi-account, whose `days` read 28/29/30 inside a
           30-day window — the correct counts, for the wrong reason. But
           api/window.js accepts days up to 3660 and from/to are unclamped, so
           "Tue Oct 01" is both 2019-10-01 and 2024-10-01 in a window a caller
           can ask for TODAY, and a person who drove one of those days on Uber
           and the other on Yango silently loses a day worked. Same trap and
           same containment as api/economics_routes.js:920, which is where the
           702-days-0-collisions count comes from. */
        set.add(isoDay(d.local_day));
        days.set(person, set);
      }
      days.forEach((set, person) => { person.days = set.size; });
    }

    res.json([...byName.values()].map((p) => {
      /* One unstatable account makes the person's grain unstatable. Resolved
         here rather than in the fold so the flag cannot survive into the
         payload as a private field somebody starts reading. */
      if (p._grainUnknown) p.money_period_days = null;
      /* This origin's address for the copy we hold, or null. Never Uber's
         signed URL — see photoHref in api/redact.js. */
      p.picture_url = photoHref(p._photo?.platform, p._photo?.id);
      /* Only when there is nothing to show AND something to say.
         Dropped first, because the fold seeds a person with `{ ...r }` and the
         raw column rides along — so a driver with nothing to explain carried
         `photo_absent_reason: null`, and a key that is present-and-null is a
         different claim from a key that is absent. The whole point of this
         field is that its presence means something. */
      delete p.photo_absent_reason;
      if (!p.picture_url && p._photoMiss) p.photo_absent_reason = p._photoMiss;
      delete p._days; delete p._multiAccountDays; delete p._grainUnknown; delete p._ratingTrips;
      delete p._photo; delete p._photoMiss; delete p.has_photo; delete p.photo_platform;
      return {
        ...p,
        // Computed once, over the whole person.
        completion_pct: p.bookable ? Math.round((p.completed / p.bookable) * 100) : null,
        // "No trip in this window" and "never driven" are different facts.
        active_in_window: p.trips > 0,
        ever_driven: (p.lifetime_trips || 0) > 0,
        /* Not expired — never entered. Reported per row so a page cannot count
           a data-quality artefact as 77 people who must stand down. */
        licence_placeholder: !!p.licence_placeholder,
      };
    }).sort((a, b) => b.trips - a.trips || String(a.driver_name).localeCompare(String(b.driver_name))));
  }));

  /* ── who this is: identity, credentials, platforms, tenure ─────────── */
  /* One driver's photograph, from this product's own store.
     ─────────────────────────────────────────────────────────────────────────
     The bytes, not a redirect. A redirect would send the reader back to the
     CloudFront URL the collector was given, which authorises for twelve hours
     and is therefore dead by the time almost anybody follows it — that is the
     whole defect this route exists to close.

     Its own route, and never inlined into a list response. Measured on
     production, /api/drivers/directory is already 513kb; base64ing 153 avatars
     into it at about 20kb each would make it 4.6MB, and api/cache.js is
     byte-bounded at 64MB — fourteen cached copies of one page before the cache
     starts evicting the rest of the product. An image belongs on a URL a
     browser can cache by itself.

     Cached hard and validated by digest. The bytes for a given driver change
     only when Uber's photograph does, which is approximately never, so the
     ETag is the sha256 and a repeat visit costs a 304. immutable is not used:
     the address is stable across content changes, so a validator is right and
     a promise of immutability would be a lie. */
  app.get('/api/driver/photo/:platform/:id', wrap(async (req, res) => {
    const rows = await q(
      `SELECT bytes, content_type, byte_len, sha256, fetched_at
         FROM driver_photo WHERE platform = $1 AND driver_ext_id = $2`,
      [String(req.params.platform || '').toLowerCase(), req.params.id]);
    const row = rows[0];
    /* 404, and a reason. A driver with no photograph on file is not an error,
       and the caller — an <img> — cannot read a body, so the reason goes in a
       header where a person debugging can still find it. */
    if (!row) {
      res.set('x-photo', 'none on file for this driver');
      return res.status(404).json({ error: 'no photo on file for this driver' });
    }
    /* The declared type is checked HERE as well as at the point it was stored.
       ─────────────────────────────────────────────────────────────────────
       These bytes came from a host we do not run, and this route hands them
       back on our own origin — so a content type of image/svg+xml or text/html
       would be a script running as this site. src/sources/uber_profile.js has
       an allowlist and will not write one; the reason to repeat it is that the
       guarantee then lives where the header is written rather than one module
       away, and a future writer to this table inherits it. nosniff closes the
       other half: a browser that ignores the declared type and sniffs the body
       can reach the same place from a file that is a valid image AND a valid
       HTML document. */
    const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    /* nosniff FIRST, so it is on the refusal too. It used to be set after this
       branch had already returned, which left the one response most likely to
       be sniffed — the one carrying a type we would not serve — as the only
       response that did not say not to guess. */
    res.set('x-content-type-options', 'nosniff');
    if (!TYPES.has(row.content_type)) {
      res.set('x-photo', `stored type ${row.content_type} is not one this route will serve`);
      return res.status(415).json({ error: 'the stored photograph is not an image type this route serves' });
    }
    const etag = `"${row.sha256}"`;
    res.set('etag', etag);
    res.set('cache-control', 'private, max-age=86400, stale-while-revalidate=604800');
    res.set('content-type', row.content_type);
    res.set('content-disposition', 'inline');
    res.set('x-photo-fetched', new Date(row.fetched_at).toISOString());
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set('content-length', String(row.byte_len));
    return res.end(row.bytes);
  }));

  app.get('/api/driver/profile', withDriver(async (req, res, d, p) => {
    const [span] = await q(
      `SELECT min(requested_at) first_trip, max(requested_at) last_trip, count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              count(DISTINCT plate)::int vehicles, min(fleet_id) fleet_id
       FROM trip WHERE ${TW}`, p);
    /* The identity documents leave this route the same way they leave
       /api/compliance/drivers, through the same helper.
       ─────────────────────────────────────────────────────────────────────
       That route stopped serving emirates_id and licence_no to an anonymous
       caller; this one did not, and it is the more exposed of the two — the
       roster hands out a list, this hands out ONE NAMED PERSON'S papers, which
       is the shape somebody actually wants. Measured on production 2026-09-05
       with curl and no credentials:
       /api/driver/profile?id=67483c64055e070d791000fa returned
       {emirates_id: '784-1977-5137316-4', licence_no: '123456'}.

       The columns are still SELECTed, because an administrator presenting
       x-admin-token gets them, and because the counts and the expiry dates
       below are derived from the same rows. What changes is what leaves. */
    const complianceRows = await q(
      `SELECT platform, driver_ext_id, full_name, phone, email, picture_url,
              emirates_id, licence_no, licence_expires,
              (licence_expires - now()::date) AS licence_days_left, state, suspension_reason,
              rating, device_brand, device_model, updated_at
       FROM driver_compliance WHERE driver_ext_id = ANY($1)
       /* ORDERED, because the driver page reads compliance[0] and this query
          had no ORDER BY at all — so for a person with both a hotel record and
          an Uber one, "the first row" was whichever the planner happened to
          return, and the page could show no photograph, no phone and no email
          while all three sat in the row behind it. Rows that carry contact
          details come first, and Uber's come before the rest because it is the
          only channel that files a photograph. */
       ORDER BY (picture_url IS NOT NULL) DESC,
                (coalesce(phone, email) IS NOT NULL) DESC,
                (platform = 'uber') DESC, platform`, [d.keys]);
    const admin = isAdmin(req);
    /* Our own address for the photograph, never Uber's twelve-hour signed one.
       One key-only read, no bytes. */
    const held = new Map((await q(
      `SELECT platform, driver_ext_id FROM driver_photo WHERE driver_ext_id = ANY($1)`,
      [d.keys])).map((r) => [r.driver_ext_id, r.platform]));
    const missed = new Map((await q(
      `SELECT driver_ext_id, reason FROM driver_photo_miss WHERE driver_ext_id = ANY($1)`,
      [d.keys])).map((r) => [r.driver_ext_id, r.reason]));
    const compliance = withPhotos(stripIdentity(complianceRows, admin), held, missed);
    /* Which of them this person actually HAS, counted before the values were
       dropped. Without this the page cannot tell "withheld" from "the hotel
       channel never filed one", and those are the two states the whole
       #compliance page exists to keep apart. */
    const identityHeld = admin ? null : IDENTITY_DOCS.filter(
      (c) => complianceRows.some((r) => String(r[c] ?? '').trim() !== ''));
    const vehicles = await q(
      `SELECT plate, count(*)::int days, sum(trips)::int trips, round(sum(km)::numeric,0) km,
              round(sum(revenue)::numeric,0) revenue, min(day) first_day, max(day) last_day,
              bool_or(is_primary) ever_primary
       FROM vehicle_driver_day WHERE driver_ext_id = ANY($1)
       GROUP BY plate ORDER BY days DESC LIMIT 40`, [d.keys]);
    const accounts = await q(
      `SELECT platform, ${PKEY} AS driver_ext_id, count(*)::int trips,
              min(requested_at) first_trip, max(requested_at) last_trip
       FROM trip WHERE ${PKEY} = ANY($1) GROUP BY 1,2 ORDER BY trips DESC`, [d.keys]);
    /* What each platform says about this person's standing.
       ─────────────────────────────────────────────────────────────────────
       This route never touched driver_platform_state, so a suspended driver's
       own page could not show that they were suspended, why, their Bolt score,
       or the plate they are still holding — all of which #roster/blocked shows
       about the same person. Two pages in one product, one of them saying
       nothing about the fact the other exists to report. */
    const standing = await q(
      `SELECT platform, fleet_id, state, state_raw, state_reason, plate, vehicle_ext_id,
              score, can_earn, observed_at,
              /* What the PLATFORM says about the person, as opposed to about
                 their work. Uber answers all four on GetDriver and nothing
                 here asked until sql/schema_v45.sql; the roster has shown a
                 column of dashes under a sentence saying no channel reports a
                 rating, which was a fact about our questions and not about the
                 channels. profile_at is separate from observed_at because the
                 roster is read every half hour and this once a day. */
              rating, lifetime_trips, is_banned, compliance_status, profile_at
       FROM driver_platform_state WHERE driver_ext_id = ANY($1)
       ORDER BY platform`, [d.keys]);
    /* One person, several platform rows. The rating is the platform's, so it
       is NOT averaged across them — two platforms rating the same human are
       two opinions on two scales, and a mean of them is a number neither
       provider would recognise. The best-attested one leads and the rest are
       in `standing` for a reader who wants them. */
    const rated = standing.filter((r) => r.rating != null)
      .sort((a, b) => (b.lifetime_trips || 0) - (a.lifetime_trips || 0));
    const banned = standing.filter((r) => r.is_banned === true);
    res.json({ ...d,
      span, compliance, standing, vehicles, accounts,
      /* Named, so the page captions the gap instead of implying the provider
         sent nothing. Empty for an administrator. */
      identity_withheld: admin ? [] : IDENTITY_DOCS,
      identity_held: identityHeld,
      identity_withheld_reason: admin ? null
        : withheldNote('licence numbers and Emirates IDs'),
      rating: rated[0]?.rating ?? null,
      rating_platform: rated[0]?.platform ?? null,
      rating_at: rated[0]?.profile_at ?? null,
      rating_platforms: rated.length,
      /* Uber's own lifetime count, which is a cross-check on ours rather than a
         replacement: theirs covers the whole relationship, ours covers what we
         collected. Shown side by side, never merged. */
      platform_lifetime_trips: rated[0]?.lifetime_trips
        ?? standing.find((r) => r.lifetime_trips != null)?.lifetime_trips ?? null,
      banned_on: banned.map((r) => r.platform),
      platform_compliance: standing.filter((r) => r.compliance_status)
        .map((r) => ({ platform: r.platform, status: r.compliance_status })),
    });
  }));

  /* ── headline numbers, plus the shift shape the mockup asks for ────── */
  app.get('/api/driver/kpis', withDriver(async (req, res, d, p) => {
    const [t] = await q(
      `SELECT count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              /* has_distance and has_fare, the same two rules the rest of the
                 product applies and these two figures did not.
                 ─────────────────────────────────────────────────────────
                 sql/schema_v18.sql:83 excludes complimentary rides from
                 has_fare because counting a ride given away as revenue made
                 the fleet headline disagree with the settlement page by
                 AED 320 over one window, and :88 excludes odometer-derived
                 FMS distances outside a sane range. Both were being applied
                 at the fleet grain, in src/rollup.js when it wrote
                 driver_day, and on this endpoint's own priced_km — but not to
                 the km and revenue on the tiles, so a driver's page answered
                 a question differently from the page that links to it. */
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric,0) km,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric,1) avg_km,
              -- avg() skips NULLs, so avg_km is over the trips that REPORT a
              -- distance and km/trips does not reproduce it. Returned so the
              -- tile can print the denominator it actually used.
              count(*) FILTER (WHERE has_distance)::int trips_with_distance,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              round(avg(price) FILTER (WHERE has_fare)::numeric,2) avg_fare,
              -- Normalised, because the four platforms do not share a status
              -- vocabulary: Bolt says 'finished' for a completed trip and
              -- 'client_did_not_show' / 'driver_did_not_respond' /
              -- 'driver_rejected' for three of its four failure modes, none of
              -- which match ILIKE '%cancel%'. FMS telematics rows hardcode
              -- 'completed' and cannot be cancelled at all, so they are dropped
              -- from both sides by the outcome IS NOT NULL denominator rather
              -- than inflating this person's success rate.
              round(100.0*count(*) FILTER (WHERE outcome='completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct,
              round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) cancel_pct,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              /* The two numerators, beside the two rates they came from. The
                 rates shipped with only their denominator, so "90.5%" was a
                 figure the reader had to take on trust — while /api/kpis, six
                 inches away on another page, reports both. A rate nobody can
                 check against its own numerator is the same shape of claim
                 this product refuses to make about a verdict. */
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int not_completed,
              count(*) FILTER (WHERE is_booking)::int bookings,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              count(*) FILTER (WHERE has_distance)::int trips_with_distance,
              /* The distance of the PRICED trips. Revenue per km divided the
                 fares of the few trips that carry one by the distance of ALL of
                 them, which is a ratio between two different populations and
                 comes out an order of magnitude too low on any driver working
                 mostly Uber — whose trip export has no fare column at all. */
              round(sum(distance_km) FILTER (WHERE has_fare AND has_distance)::numeric,0) priced_km,
              -- and the revenue of exactly those trips, so per-km is a ratio
              -- between one population rather than two
              round(sum(price) FILTER (WHERE has_fare AND has_distance)::numeric,2) priced_measured_revenue,
              count(*) FILTER (WHERE has_fare AND has_distance)::int priced_measured_trips,
              round(avg(duration_s)::numeric/60,1) avg_minutes,
              count(DISTINCT plate)::int vehicles, count(DISTINCT platform)::int platforms
       FROM trip_norm WHERE ${TW}`, p);
    // "typical start" — the median hour of the first trip of each working day,
    // which is a far better description of a shift than the mean of all trips.
    const [shift] = await q(
      `WITH d AS (
         SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                min(requested_at AT TIME ZONE 'Asia/Dubai') first_local,
                max(requested_at AT TIME ZONE 'Asia/Dubai') last_local
         FROM trip WHERE ${TW} GROUP BY 1)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from first_local::time))/3600 median_start_h,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from last_local::time))/3600 median_end_h,
              round(avg(extract(epoch from (last_local-first_local))/3600)::numeric,1) avg_span_h,
              round(stddev_samp(extract(epoch from first_local::time)/3600)::numeric,2) start_consistency_h
       FROM d`, p);
    const [perf] = await q(
      /* No hours here any more, and that is the fix rather than an omission.
         ─────────────────────────────────────────────────────────────────────
         This selected sum(hours_online) from driver_payout_day, whose view
         divides a platform PERIOD's hours evenly across the days it covers
         (sql/schema_v23.sql:64). Yango is the only channel that files hours and
         it files seven-day windows, so every figure this produced was a week
         divided by seven and printed as if somebody had measured the day.

         What it printed: Khalil Aliyan, twelve trips and four hours of work in
         the whole of August, tile reading 428.8 hours online — 14.3 hours a
         day, every day, including the twenty-four days they did not drive. And
         Fahad Ali, 485.7 hours against the 255.7 the availability feed actually
         recorded for the same month on the same page.

         The hours now come from driver_day below, which is a measurement, and
         the weekly figures are still shown where their grain is visible: the
         periods table on the Earnings tab prints them against the real period
         bounds, which is the one place a week-long number can be read as one. */
      /* No rating here either, and for the same reason as the hours above it.
         This averaged driver_payout_day.rating — a column that traces back to
         driver_performance, which no collector has ever written a rating into.
         It produced a null on every driver, and being spread into the response
         it could shadow a real one. The rating now comes from the platform
         that actually publishes it, below. */
      `SELECT round(avg(acceptance_rate)::numeric,3) acceptance_rate,
              round(avg(cancellation_rate)::numeric,3) cancellation_rate,
              round(sum(earnings)::numeric,2) reported_earnings,
              round(sum(cash_earnings)::numeric,2) cash_earnings,
              /* THE GRAIN THE MONEY WAS FILED AT, returned beside the money.
                 ───────────────────────────────────────────────────────────
                 driver_payout_day.earnings is period earnings divided by the
                 period's days (sql/schema_v23.sql:61). Over a window that
                 contains whole periods that is exact. Over a window NARROWER
                 than a period it is a share, apportioned evenly across days
                 the driver did not work evenly.

                 This file already refuses that arithmetic for hours, forty
                 lines below, on the grounds that the same view's hours_online
                 is "a week divided by seven and printed as a measurement".
                 The money column is divided by the identical expression and
                 was printed with no such qualification: on production
                 2026-09-06 a driver's one-day tile read "AED 312 paid out"
                 for a figure no payout ever paid on that day.

                 The money is not changed — it is correct, and the days sum
                 back to the period exactly. What was missing is the grain, so
                 the tile can say what it is holding. */
              max(period_days)::int payout_period_days,
              count(DISTINCT (platform, period_start, period_end))::int payout_periods,
              min(period_start) payout_from,
              max(period_end) payout_to
       /* Day grain, and the window applied to the day. Summed over
          driver_performance this counted the same payout week two and three
          times — the provider is asked for overlapping report windows and the
          window is the row's key. See sql/schema_v23.sql.

          It also read period_start >= from AND period_end <= to, which is
          "periods wholly inside the window": a 30-day view of weekly payouts
          silently dropped the two weeks straddling its edges, so the driver's
          earnings jumped whenever the window moved past a Monday. */
       FROM driver_payout_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    /* Hours, from the two feeds that measure them, with the same per-day
       precedence /api/driver/daily uses — so the tile and the chart under it
       cannot disagree.
       ─────────────────────────────────────────────────────────────────────
       The platform's OWN daily figure first, where a channel files one.
       Otherwise driver_day.online_min: Uber's ONLINE spans, folded into Dubai
       days and stored.

       What is deliberately absent is driver_payout_day.hours_online, which
       this used to sum. That view divides a platform PERIOD's hours evenly
       across the days it covers (sql/schema_v23.sql:64), and the only channel
       filing hours files seven-day windows — so every figure it produced was a
       week divided by seven and printed as a measurement. On production it put
       428.8 hours against a driver with twelve trips and four hours of work,
       and 485.7 against a month the availability feed measured at 255.7, on
       this same page. The weekly figures are still shown where their grain is
       visible: the periods table on the Earnings tab prints them against the
       real period bounds.

       FULL OUTER JOIN, because a day can be known to either feed alone: a
       platform that reports hours for a day with no availability, and — far
       more common here — availability for a day no platform reported. */
    const [kept] = await q(
      `WITH ph AS (
         SELECT period_start AS day, sum(hours_online) hours_online,
                sum(hours_on_trip) hours_on_trip
           FROM driver_performance
          WHERE driver_ext_id = ANY($3) AND period_start = period_end
            AND period_start BETWEEN $1::date AND $2::date
          GROUP BY 1),
       av AS (
         SELECT day, sum(online_min) online_min, sum(on_job_min) on_job_min,
                sum(idle_online_min) idle_online_min
           FROM driver_day
          WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
          GROUP BY 1),
       d AS (
         SELECT CASE WHEN ph.hours_online IS NOT NULL THEN ph.hours_online
                     ELSE av.online_min / 60.0 END AS online_h,
                CASE WHEN ph.hours_online IS NOT NULL THEN ph.hours_on_trip
                     ELSE av.on_job_min / 60.0 END AS on_job_h,
                /* Always the stored one: idle-online is online minus on-job
                   measured against the same clock, and no platform here
                   publishes it at all. */
                av.idle_online_min / 60.0 AS idle_h,
                CASE WHEN ph.hours_online IS NOT NULL THEN 'platform'
                     WHEN av.online_min IS NOT NULL THEN 'availability' END AS basis
           FROM ph FULL OUTER JOIN av USING (day))
       /* Numerator and denominator over the SAME days.
          ────────────────────────────────────────────────────────────────
          on_job_h lands on every day that carries on-job minutes; online_h
          only on days that carry online minutes. Summed unfiltered and then
          divided, that is a ratio between two different day sets — and on
          production it read 437.4% for one driver: 2,112.5 on-job hours over
          483 online, across 36 days that had a basis and an unknown number
          that did not. A utilisation over 100% is not a busy driver, it is
          two questions answered as one.

          So the ratio's halves are both restricted to the days that carry a
          basis, and the unrestricted on-job total is returned beside them
          under its own name for the panels that legitimately want every day
          of work rather than every day of measurement. */
       SELECT round(sum(online_h)::numeric,1) online_h,
              round(sum(on_job_h) FILTER (WHERE basis IS NOT NULL)::numeric,1) on_job_h,
              round(sum(on_job_h)::numeric,1) on_job_h_all_days,
              count(*) FILTER (WHERE on_job_h IS NOT NULL)::int on_job_days_all,
              round(sum(idle_h) FILTER (WHERE basis IS NOT NULL)::numeric,1) idle_online_h,
              count(*) FILTER (WHERE basis IS NOT NULL)::int online_days,
              count(*) FILTER (WHERE basis = 'platform')::int platform_days,
              count(*) FILTER (WHERE basis = 'availability')::int availability_days
         FROM d`, p);
    /* What this person's work brought in, both channels, per platform.
       `revenue` above is the fares on their trips, and the Uber export has no
       fare column — so a driver working Uber and one hotel booking led with the
       price of the hotel booking. Their actual pay was already in this response
       as `reported_earnings` and the tile strip did not show it.

       Per platform, and the same rule the fleet and vehicle pages use
       (api/income_sql.js): a payout is what is left of a channel's own fares
       after its commission, so a channel reporting both contributes one. */
    const [fareByPlat, payByPlat] = await Promise.all([
      q(`SELECT platform, count(*)::int bookings,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                /* The denominator fare coverage is taken over — see
                   platformFares in api/income_sql.js. A ride nobody took has
                   no fare and never will; counting it as missing coverage made
                   Bolt read 63.8% covered on a month it priced 99.7% of its
                   completed rides. */
                count(*) FILTER (WHERE ${COMPLETED_SQL()} OR has_fare)::int chargeable_bookings,
                count(*) FILTER (WHERE NOT (${COMPLETED_SQL()}) AND NOT has_fare)::int uncharged_bookings,
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
                /* The days this channel actually WORKED for this person, which
                   is the denominator chooseBasis measures payout coverage
                   against — the identical omission /api/vehicle/kpis carried,
                   fixed in the same change so the two pages cannot disagree.
                   ───────────────────────────────────────────────────────────
                   This half of that change is PREVENTIVE, and the honest
                   reason for making it is not that a driver's page is printing
                   a wrong number today. coverage() in api/income_sql.js reads
                   booking_days > 0 ? booking_days : windowDays, so without
                   this column the payout's day count is divided by the length
                   of the CALENDAR window — wrong arithmetic on any person who
                   worked fewer days than the window is long, and on the
                   vehicle ledger it is wrong out loud: a net AED 64,632.54 of
                   excess across the 45 of 98 earning plates whose page
                   disagrees with their directory row for 2026-08, re-measured
                   2026-09-05T19:44Z. Here it is wrong quietly, and it was
                   quiet before this change too. Measured on the same day over
                   the same window: of the 97 people /api/economics/drivers
                   holds a payout for in 2026-08, not one has a payout covering
                   under 80% of the 31-day window while covering 80% or more of
                   the days that person actually worked — which is the only
                   shape that moves a row out of the payout branch — and the
                   same count at 7, 14 and 92 days is zero as well. Two things
                   keep it at zero: Uber's payments walk lands a payout row on
                   nearly every calendar day it reaches, so both denominators
                   give the same answer, and the people it reaches carry no
                   per-trip fare for the page to fall back TO — the ledger
                   reports fares null for every one of the twelve largest.

                   So this is the same omission repaired before it produced a
                   visible figure. That is a good enough reason on its own: the
                   Uber fare backfill is live and moves both halves weekly, the
                   day the two denominators stop agreeing is a day nobody would
                   be watching for, and two pages answering the same question
                   about the same person must not answer it differently.
                   platformFares in api/income_sql.js and
                   /api/economics/drivers have always selected it. */
                count(DISTINCT local_day)::int booking_days
         FROM trip_norm WHERE ${TW} AND is_booking GROUP BY 1`, p),
      q(`SELECT platform, round(sum(earnings)::numeric,2) payouts,
                count(DISTINCT day)::int payout_days
         FROM driver_payout_day
         WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
         GROUP BY 1`, p),
    ]);
    const byPlat = new Map();
    const plat = (name) => {
      if (!byPlat.has(name)) {
        byPlat.set(name, { platform: name, bookings: 0, booking_days: 0, priced_bookings: 0,
          fares: null, payouts: null, payout_days: 0 });
      }
      return byPlat.get(name);
    };
    const n = (v) => (v == null ? null : Number(v));
    for (const f of fareByPlat) Object.assign(plat(f.platform), {
      bookings: f.bookings, priced_bookings: f.priced_bookings, fares: n(f.fares),
      chargeable_bookings: f.chargeable_bookings, uncharged_bookings: f.uncharged_bookings,
      /* Copied onto the row, not merely selected — the default above seeds
         booking_days at 0, and 0 is the exact value that sends coverage() back
         to the calendar window. */
      booking_days: f.booking_days });
    for (const y of payByPlat) Object.assign(plat(y.platform), {
      payouts: n(y.payouts), payout_days: y.payout_days ?? 0 });
    /* THE STATEMENT HALF, WITHOUT WHICH THIS PERSON CANNOT BE COUNTED THE WAY
       THE FLEET COUNTS THEM.
       ─────────────────────────────────────────────────────────────────────
       api/income_sql.js now takes a channel's statement net ahead of its
       payout — the payout being what was wired to the bank rather than what
       the work earned. These rows carried only fares and payouts, so
       chooseBasis could never reach that branch for a driver and every
       per-driver `accounted` in the product stayed on the old basis. Measured
       on production for 2026-09-01..09-07: /api/economics/drivers reported this
       person at AED 2,635.62 on "uber: payout, yango: payout" while the People
       list and their own profile both read AED 3,266.

       Keyed on driver_ext_id, which the API statements DO carry: src/rollup.js
       groups driver_earnings_component by driver_ext_id when it writes them
       (:809-838). The rows with a null id are the operator's imported
       workbook, and `source <> 'ledger'` excludes those anyway — for the
       reason api/income_sql.js:154 gives, and the one /api/day was caught
       breaking. */
    const stmtByPlat = await q(
      `SELECT platform, round(sum(net)::numeric, 2) statement_net,
              count(DISTINCT day)::int statement_days
         FROM driver_statement_day
        WHERE source <> 'ledger' AND driver_ext_id = ANY($3)
          AND day BETWEEN $1::date AND $2::date AND net IS NOT NULL
        GROUP BY 1`, p);
    for (const t2 of stmtByPlat) Object.assign(plat(t2.platform), {
      statement_net: n(t2.statement_net), statement_days: t2.statement_days ?? 0 });
    /* DAYS IN THE WINDOW, counted on the days and not on the timestamps.
       ─────────────────────────────────────────────────────────────────────
       win() widens the upper bound to 23:59:59.999 (see DAYWIN above), so the
       difference between the two bounds is 0.99999 of a day for a single-day
       window, not 0. Rounding that to 1 and adding the inclusive +1 gave TWO
       days for one day, eight for a week, thirty-one for a month — every
       window one day too long.

       Surfaced by returning the figure: /api/driver/kpis?from=2026-09-06&
       to=2026-09-06 answered window_days 2. It had been feeding coverage()
       silently since it was written, where it is the base a payout's coverage
       is divided by whenever a channel has payouts and no bookings in the
       window (api/income_sql.js:163) — so exactly those channels reported a
       coverage percentage lower than the truth.

       Both bounds truncated to their date first, which is the grain every
       predicate in this file already compares on — through isoDay(), not
       String(v).slice(0, 10). test/driver_day_keys.test.mjs bans that shape in
       this module and caught this on the first run: a pg DATE through String()
       is "Tue Oct 01 2026 …", so slicing it yields "Tue Oct 0". These two
       bounds are query-string text today and the slice would have worked, but
       a guard that only holds while nobody changes where the value comes from
       is not a guard. isoDay() takes both shapes. */
    const windowDays = Math.round(
      (Date.parse(`${isoDay(p[1])}T00:00:00Z`) - Date.parse(`${isoDay(p[0])}T00:00:00Z`)) / 86400000) + 1;

    /* What the platforms say about the PERSON, not about the window.
       ─────────────────────────────────────────────────────────────────────
       Both tile strips on the driver page read k.rating, and it has always
       been null: it came from avg(driver_performance.rating), a column no
       collector writes. Uber answers a rating on GetDriver and now lands it on
       driver_platform_state (sql/schema_v45.sql), so the tiles read it here
       rather than each page fetching a second endpoint.

       Window-independent on purpose. A rating is the platform's standing view
       of a human; slicing it by the dates on the toolbar would imply it was
       measured over them. */
    /* Bound on $1 with the keys alone, not on the shared p triple. Postgres
       infers a parameter's type from where it is USED, and a query that binds
       three but references only the third answers "could not determine data
       type of parameter $1" — which is what every driver endpoint returned for
       a few minutes here. The window is deliberately absent: a rating is the
       platform's standing view of a human, and slicing it by the dates on the
       toolbar would imply it was measured over them. */
    const standing = await q(
      `SELECT platform, rating, lifetime_trips, is_banned, compliance_status, profile_at
       FROM driver_platform_state
       WHERE driver_ext_id = ANY($1) AND (rating IS NOT NULL OR is_banned IS NOT NULL
             OR lifetime_trips IS NOT NULL OR compliance_status IS NOT NULL)
       ORDER BY lifetime_trips DESC NULLS LAST`, [p[2]]);
    const rated = standing.filter((r) => r.rating != null);
    /* Is it going up? — which is the question a rating is actually asked.
       ─────────────────────────────────────────────────────────────────────
       Two readings, the newest and the one before it, from the kept history
       (sql/schema_v46.sql). Deliberately NOT a fixed "last week": the pull is
       weekly but a missed week must not be reported as a week of no change, so
       the comparison is against the previous READING and the gap in days is
       returned with it. A driver read once has no change — `first reading`,
       not zero, because zero is a measurement and this is an absence.

       lifetime_trips comes too, because it is the denominator: 0.02 over 40
       trips and 0.02 over 900 are different events and only the second is
       signal. */
    const [trend] = await q(
      `WITH h AS (
         SELECT platform, rating, lifetime_trips, observed_on,
                row_number() OVER (PARTITION BY platform ORDER BY observed_on DESC) AS rn
           FROM driver_rating_history
          WHERE driver_ext_id = ANY($1) AND rating IS NOT NULL)
       SELECT max(rating) FILTER (WHERE rn = 1)         AS latest,
              max(rating) FILTER (WHERE rn = 2)         AS previous,
              max(observed_on) FILTER (WHERE rn = 1)    AS latest_on,
              max(observed_on) FILTER (WHERE rn = 2)    AS previous_on,
              max(lifetime_trips) FILTER (WHERE rn = 1) AS latest_trips,
              max(lifetime_trips) FILTER (WHERE rn = 2) AS previous_trips,
              count(*)::int                             AS readings
         FROM h`, [p[2]]);
    /* The readings themselves, newest last, for a sparkline. Capped at twelve
       — a quarter of weekly pulls — because a rating line longer than the eye
       can read in a 90-pixel tile is decoration, and because the question the
       tile answers is "which way lately", not "the whole history". */
    const series = await q(
      `SELECT to_char(observed_on, 'YYYY-MM-DD') AS on, max(rating) AS rating,
              max(lifetime_trips) AS trips
         FROM driver_rating_history
        WHERE driver_ext_id = ANY($1) AND rating IS NOT NULL
        GROUP BY observed_on ORDER BY observed_on DESC LIMIT 12`, [p[2]]);
    series.reverse();
    const chg = (trend?.latest != null && trend?.previous != null)
      ? { change: +(Number(trend.latest) - Number(trend.previous)).toFixed(3),
        over_days: Math.round(
          (Date.parse(trend.latest_on) - Date.parse(trend.previous_on)) / 86400000) || null,
        over_trips: (trend.latest_trips != null && trend.previous_trips != null)
          ? trend.latest_trips - trend.previous_trips : null,
        from: Number(trend.previous), to: Number(trend.latest) }
      : null;
    /* WHAT THE PLATFORM SAYS THE FARES WERE.
       ─────────────────────────────────────────────────────────────────────
       Uber's trip export carries no fare column, so `revenue` above — which is
       sum(trip.price) over has_fare — is null for every Uber-only driver. The
       Fares tile on the overview and the Booked revenue tile under Earnings
       therefore both read a dash for people who billed six figures, and the
       page said "where the platform reports fares" as though the platform
       reported none.

       It reports them. Not per trip, but as the `fare` line of the weekly
       statement's earnings breakdown — driver_earnings_component, which this
       same page already draws three panels further down. AED 866,137 over one
       year across the fourteen drivers sampled on production; the tiles above
       it read "—".

       Read here so the tiles can say it, and returned UNDER ITS OWN NAME
       rather than folded into accounted_fares. That fold would be a double
       count: `fare` is the gross the rider was charged and it is the PARENT of
       the payout money in the same tree — your_earnings is fare minus the
       service fee — so the payout already beside it on the tile contains it.
       fleetIncome() therefore never sees this figure.

       Only the top of the tree is summed. little_fare, surge, wait_time,
       cancellation and the rest all carry parent 'fare' and are its
       components; adding them would double the total. 'net_fare' is the same
       line under the other platforms' vocabulary, a direct child of their
       'earnings' root, and no child is named either thing. */
    const [sfare] = await q(
      `SELECT round(sum(amount)::numeric, 2)                       AS statement_fares,
              count(DISTINCT (period_start, period_end))::int      AS statement_fare_periods,
              min(period_start)                                    AS statement_fare_from,
              max(period_end)                                      AS statement_fare_to,
              array_agg(DISTINCT category)                         AS statement_fare_lines
         FROM driver_earnings_component
        WHERE driver_ext_id = ANY($3)
          AND category IN ('fare', 'net_fare')
          AND period_start >= $1::date AND period_end <= $2::date`, p);

    /* THE OTHER FIGURE THIS SAME PAGE PRINTS FOR THE SAME DAYS.
       ─────────────────────────────────────────────────────────────────────
       The Money in tile above is fleetIncome's `accounted`: per channel, the
       PAYOUT where a payout exists and the fares where it does not
       (api/income_sql.js:511). It never reads a statement. The Activity tab
       three tabs across prints a Money column that is driver_day.money: per
       channel, the STATEMENT'S NET where a channel filed one and its fares
       where it did not (src/rollup.js:1126). It never reads a payout.

       Two disjoint halves of the same evidence, both labelled money, on one
       page, with nothing on the screen to say they are different records.

       Measured on production for the driver this came in about, 2026-09-01..
       09-07: the tile reads AED 2,946.62 and the table beneath it sums to AED
       3,231.88 over the identical seven days. Fleet-wide the gap is not an
       edge case — /api/drivers/leaderboard carries both columns in one row,
       and over 2026-08-01..08-31 all 91 people who have both disagree, AED
       513,264 of money against AED 410,017 of payout, 20% apart.

       Neither figure is wrong and this does not change either of them.
       income_sql.js:135 already says what separates them: "A payout is what
       the platform wires to the bank (net of the cash drivers already
       collected, plus tips and tolls); the statement net is gross minus
       commission, the figure an operator means by 'what did we earn' …
       showing one where a reader expects the other is how that difference
       gets reported as a bug." It was reported as a bug.

       So the tile discloses it, in the shape faresTile already uses for the
       trip-priced fares it does not add. Returned rather than recomputed on
       the client, and taken with the SAME predicate and the same CASE as the
       `k` CTE of /api/driver/daily (line 1655) — same table, same person
       array, same window — so the number named here is the number the table
       on this page prints, and no third definition of the money enters the
       product. */
    /* AND THE PARTS THAT FIGURE IS MADE OF, so a page can decompose it instead
       of asserting a decomposition.
       ─────────────────────────────────────────────────────────────────────
       The operator asked for cash on hand and the bank deposit beside the
       gross, and the first attempt at those three numbers did not add up:
       AED 3,245.50 of money against AED 2,635.62 of payout plus AED 464.08 of
       statement cash, AED 145.80 apart. Nothing on the endpoint could say why,
       because /api/driver/earnings returns statement gross, fees, cash, salik
       and tips and NOT net — so the one term that would close the arithmetic
       was the one term nobody could read.

       Every column here is on driver_day at the same driver-day grain, folded
       by the same person and the same window as `money` itself, so the parts
       and the total cannot be measured over different sets. Read from
       driver_day rather than from driver_statement_day directly for the reason
       src/rollup.js gives at :1115: statements key on the NAME fold and carry a
       null driver_ext_id on most rows, so a query keyed on the account ids
       silently drops them.

       Two identities the page may then state rather than assume, both exact by
       construction:
         gross          = stmt_net + (money - stmt_net)     ← the second term is
                          the fares on channels that filed no statement
         statement net ?= cash the driver kept + what was wired to the bank
       The second is the one that has to be MEASURED, not asserted: it holds
       only where a payout covers the same days the statement does, and the
       residual is reported rather than hidden. */
    const [dday] = await q(
      `SELECT round(sum(money)::numeric, 2)                        AS day_money,
              count(*) FILTER (WHERE money IS NOT NULL)::int       AS day_money_days,
              /* NULL, not 7, where any contributing statement does not record
                 its own window. Guessing the grain is the same class of
                 mistake as guessing the money (src/rollup.js:1133). */
              CASE WHEN bool_or(money IS NOT NULL AND money_period_days IS NULL) THEN NULL
                   ELSE max(money_period_days) END                 AS day_money_period_days,
              CASE WHEN count(DISTINCT money_source) FILTER (WHERE money_source <> 'none') > 1
                   THEN 'mixed'
                   ELSE max(money_source) FILTER (WHERE money_source <> 'none') END
                                                                   AS day_money_source,
              /* The statement side. net is the platform's OWN net, not
                 gross - fees: several channels report all three and they do
                 not reconcile to each other, which is a fact about the feeds
                 and not something to paper over by subtracting. */
              round(sum(stmt_gross)::numeric, 2)                   AS day_stmt_gross,
              round(sum(stmt_fees)::numeric, 2)                    AS day_stmt_fees,
              round(sum(stmt_net)::numeric, 2)                     AS day_stmt_net,
              round(sum(stmt_tips)::numeric, 2)                    AS day_stmt_tips,
              round(sum(stmt_salik)::numeric, 2)                   AS day_stmt_salik,
              /* CASH THE DRIVER ALREADY HOLDS. */
              round(sum(stmt_cash)::numeric, 2)                    AS day_cash,
              /* WHAT REACHED THE BANK, and the cash line the payout report
                 carries beside it — a different record of the same idea, kept
                 apart so the two can be compared rather than conflated. */
              round(sum(payout)::numeric, 2)                       AS day_payout,
              round(sum(payout_cash)::numeric, 2)                  AS day_payout_cash,
              /* What the trip rows priced. NOT money: on a channel that filed
                 a statement this is the same money seen from the other side. */
              round(sum(fares)::numeric, 2)                        AS day_fares,
              /* Coverage per part, because a null sum and a zero sum are
                 different facts and each card has to say which it is holding.
                 A part measured over fewer days than the total is a part that
                 cannot be subtracted from it without saying so. */
              count(*) FILTER (WHERE stmt_net IS NOT NULL)::int     AS day_stmt_days,
              count(*) FILTER (WHERE stmt_cash IS NOT NULL)::int    AS day_cash_days,
              count(*) FILTER (WHERE payout IS NOT NULL)::int       AS day_payout_days,
              count(*) FILTER (WHERE fares IS NOT NULL)::int        AS day_fares_days,
              count(*)::int                                         AS day_rows
         FROM driver_day
        WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);

    /* THE CASH THE TRIP FEED KNOWS ABOUT, which is not the cash the statements
       report, and is the difference between a true dash and a false one.
       ─────────────────────────────────────────────────────────────────────
       driver_statement_day.cash exists for Uber alone. Bolt, the hotel channel
       and Yango's trips never file one — so a Cash-on-hand card built on the
       statement shows a DASH for people the trip feed can prove held cash.
       Measured across the fleet for 2026-09-01..09-07: 62 of 112 people took
       cash on a channel that publishes no cash figure, worth at least AED
       5,001, and 14 of them would have been given a dash saying no channel
       reports it — while trip_ext.driver_holds_cash marks the very bookings
       they were paid for.

       The counterpart is just as useful: the set of people with a non-null
       statement cash figure is EXACTLY the set with at least one cash-paid
       Uber booking in the trip feed (89 = 89 over that week, no mismatch in
       either direction), and Uber never files a zero cash line. So a driver
       with an Uber statement and no cash line took no cash on Uber, and that
       is a measurement rather than an absence.

       Same predicate as #settlement (api/analytics_routes.js:207): the flag is
       a generated column on trip_ext, so both surfaces count the same rides. */
    const [cashTrips] = await q(
      `SELECT count(*)::int                                   AS cash_bookings,
              count(*) FILTER (WHERE price IS NOT NULL)::int   AS cash_bookings_priced,
              round(sum(price)::numeric, 2)                    AS cash_booking_value,
              array_remove(array_agg(DISTINCT platform), NULL) AS cash_booking_platforms
         FROM trip_ext WHERE ${TW} AND driver_holds_cash`, p);

    const num = (v) => (v == null ? null : Number(v));
    const hoursOnline = num(kept?.online_h);
    const hoursOnJob = num(kept?.on_job_h);
    /* Both operands checked, and that is not pedantry.
       ─────────────────────────────────────────────────────────────────────
       This read `perf?.hours_online ? (perf.hours_on_trip / perf.hours_online)`
       and hours_on_trip is null for every driver on this fleet, because nothing
       writes it. In JavaScript null/428.8 is 0 — not NaN, not null — so the
       guard passed on the denominator and the tile printed a confident 0%, in
       the critical tone, for the seven drivers who had a denominator at all.
       An invented figure accusing a named person of never carrying a passenger.

       A ratio needs both halves measured, from the same record, over the same
       days. Where either is missing the answer is that we do not know. */
    const utilisation = hoursOnline && hoursOnJob != null
      ? +((hoursOnJob / hoursOnline) * 100).toFixed(1) : null;
    res.json({ ...t, ...shift, ...perf, ...fleetIncome([...byPlat.values()], windowDays),
      /* The length of the window the caller asked for, so a tile can compare it
         with payout_period_days above and tell a whole payout from a share of
         one. The page knows its own dates, but the comparison is a statement
         about the DATA's grain and belongs beside the data that has it. */
      window_days: windowDays,
      /* The Activity tab's own Money column, summed over this same window, so
         the tile can name the figure the page prints three tabs across rather
         than leaving a reader to find the difference themselves. Numbers, not
         the NUMERIC strings pg returns, because the tile compares them. */
      day_money: num(dday?.day_money),
      day_money_days: dday?.day_money_days ?? null,
      day_money_period_days: dday?.day_money_period_days ?? null,
      day_money_source: dday?.day_money_source ?? null,
      /* The parts of that figure, at its own grain. See the query above for
         why they are read from driver_day and not from the statement and
         payout tables directly. */
      day_stmt_gross: num(dday?.day_stmt_gross),
      day_stmt_fees: num(dday?.day_stmt_fees),
      day_stmt_net: num(dday?.day_stmt_net),
      day_stmt_tips: num(dday?.day_stmt_tips),
      day_stmt_salik: num(dday?.day_stmt_salik),
      day_cash: num(dday?.day_cash),
      day_payout: num(dday?.day_payout),
      day_payout_cash: num(dday?.day_payout_cash),
      day_fares: num(dday?.day_fares),
      day_stmt_days: dday?.day_stmt_days ?? null,
      day_cash_days: dday?.day_cash_days ?? null,
      day_payout_days: dday?.day_payout_days ?? null,
      day_fares_days: dday?.day_fares_days ?? null,
      day_rows: dday?.day_rows ?? null,
      /* The trip feed's own answer to "did this person handle cash", so a card
         whose figure comes from the statements can tell a real absence from a
         channel that simply never files one. */
      cash_bookings: cashTrips?.cash_bookings ?? 0,
      cash_bookings_priced: cashTrips?.cash_bookings_priced ?? 0,
      cash_booking_value: num(cashTrips?.cash_booking_value),
      cash_booking_platforms: cashTrips?.cash_booking_platforms ?? [],
      hours_online: hoursOnline,
      /* on_job, not on_trip: request to dropoff, which contains the approach
         and the rider's wait. No feed here separates them. */
      hours_on_job: hoursOnJob,
      /* Every day of work, not only the days a basis measured — the panels
         that ask "how long was this person on jobs" want all of them, and the
         utilisation ratio above deliberately does not. Returned separately so
         the two can never be summed into one another again. */
      hours_on_job_all_days: num(kept?.on_job_h_all_days),
      hours_on_job_days: kept?.on_job_days_all ?? null,
      hours_idle_online: num(kept?.idle_online_h),
      /* Which feed answered, and mixed where the window contains both — a
         platform's on-trip figure and our request-to-dropoff fold are not the
         same measure, and a total drawn from both should say so. */
      hours_basis: hoursOnline == null ? null
        : (kept.platform_days && kept.availability_days) ? 'mixed'
          : kept.platform_days ? 'platform' : 'availability',
      hours_days: kept?.online_days ?? 0,
      trips_per_day: t.days_worked ? +(t.trips / t.days_worked).toFixed(1) : null,
      utilisation_pct: utilisation,
      /* After the ...perf spread, deliberately: perf carries a rating column
         from driver_performance that nothing writes, and letting it win would
         put the null back over a real number. */
      rating: rated[0]?.rating ?? null,
      rating_platform: rated[0]?.platform ?? null,
      rating_at: rated[0]?.profile_at ?? null,
      /* null when there is only one reading — "first reading", never a change
         of zero. A zero is a measurement; this is the absence of a second
         observation to measure against. */
      rating_change: chg,
      rating_readings: trend?.readings ?? 0,
      rating_series: series.map((r) => ({ on: r.on, rating: Number(r.rating),
        trips: r.trips == null ? null : Number(r.trips) })),
      /* Beside accounted_fares, never inside it — see the query above. */
      statement_fares: num(sfare?.statement_fares),
      statement_fare_periods: sfare?.statement_fare_periods || 0,
      statement_fare_from: sfare?.statement_fare_from ?? null,
      statement_fare_to: sfare?.statement_fare_to ?? null,
      platform_lifetime_trips: standing.find((r) => r.lifetime_trips != null)?.lifetime_trips ?? null,
      banned_on: standing.filter((r) => r.is_banned === true).map((r) => r.platform),
      platform_compliance: standing.filter((r) => r.compliance_status)
        .map((r) => ({ platform: r.platform, status: r.compliance_status })) });
  }));

  /* ── day by day: the spine every chart on the detail page hangs off ── */
  app.get('/api/driver/daily', withDriver(async (req, res, d, p) => res.json(await q(
    `WITH t AS (
       SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              count(*)::int trips,
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              -- The same two rules as the tiles above and as driver_day: a
              -- complimentary ride is not revenue, and an odometer-derived
              -- distance outside a sane range is not a distance.
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric,1) km,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              min(requested_at) first_trip_at, max(requested_at) last_trip_at,
              extract(epoch from (min(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 first_hour,
              extract(epoch from (max(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 last_hour,
              round((extract(epoch from (max(requested_at)-min(requested_at)))/3600)::numeric,2) span_h,
              string_agg(DISTINCT plate, ',') plates,
              string_agg(DISTINCT platform, ',') platforms
       FROM trip_norm WHERE ${TW} GROUP BY 1),
     h AS (
       SELECT period_start AS day, sum(hours_online) hours_online, sum(hours_on_trip) hours_on_trip,
              sum(earnings) earnings
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_start = period_end
         AND period_start BETWEEN $1::date AND $2::date
       GROUP BY 1),
     /* The kept per-day record, and the reason this panel was blank.
        ─────────────────────────────────────────────────────────────────────
        h above is the platform's OWN daily figure, and it fires for nobody.
        driver_performance.hours_online has exactly one writer in this codebase
        — src/sources/yango.js:86 — and it files SEVEN-DAY windows, which the
        period_start = period_end predicate directly above then discards.
        hours_on_trip has no writer at all. So the panel rendered "No
        platform-reported hours in this window" directly beneath a shift
        timeline reading 405 h online, and beside a stored per-day record
        holding the same 405 h. The fact was collected, derived and kept; only
        this query did not ask for it. h is left in place because a channel
        that starts filing daily rows should still win — it is the provider's
        own arithmetic rather than ours — but it answers nothing today.

        driver_day is the record: ONLINE spans from driver_timeline_event (the
        availability feed), clamped to Dubai days by src/rollup.js and stored.
        Two things it is NOT:

          it is not driver_payout_day.hours_online, which divides a Yango WEEK
          by seven (sql/schema_v23.sql:64). That column is why the KPI tile on
          this same page reported 428.8 hours for a driver with four hours of
          work — a weekly total stated as a daily measurement. It is read
          nowhere on this page now.

          and on_job_min is not "on trip". Uber's export carries a request time
          and a dropoff time and nothing between them, so this span contains
          the approach and the rider's wait as well as the ride. It is emitted
          as hours_on_job and labelled request-to-dropoff wherever it is drawn;
          calling it time with a passenger would be a claim no feed supports. */
     k AS (
       SELECT day, sum(online_min) online_min, sum(on_job_min) on_job_min,
              sum(idle_online_min) idle_online_min,
              round(sum(money)::numeric, 2) money,
              /* The parts of the money, per day, so the residual between the
                 gross and (cash + bank) can be located on the day it arises
                 rather than inferred from a window total. Same columns and
                 same reasoning as the block in /api/driver/kpis. */
              round(sum(stmt_gross)::numeric, 2) stmt_gross,
              round(sum(stmt_fees)::numeric, 2)  stmt_fees,
              round(sum(stmt_net)::numeric, 2)   stmt_net,
              round(sum(stmt_cash)::numeric, 2)  cash,
              round(sum(payout)::numeric, 2)     payout,
              round(sum(payout_cash)::numeric, 2) payout_cash,
              /* The report window the money was measured over. Uber files this
                 fleet's earnings WEEKLY and src/rollup.js divides each one
                 across its seven days, so seven consecutive days carry a
                 seventh of one number each — identical values, and none of
                 them a measurement of its own day. Production made the point
                 the moment this column shipped: 309.88 for seven days running,
                 then 446.84 for the next seven. The figure is right at the
                 week and allocated at the day, and the page has to be able to
                 say which. See sql/schema_v44.sql. */
              max(money_period_days) money_period_days,
              /* mixed the moment a person's day was reached two ways — one
                 platform filing a statement, another reporting only fares. */
              CASE WHEN count(DISTINCT money_source) FILTER (WHERE money_source <> 'none') > 1
                   THEN 'mixed' ELSE max(money_source) FILTER (WHERE money_source <> 'none') END money_source
       FROM driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       GROUP BY 1),
     /* The spine is every day ANY feed knows about, not only the days with
        trips.
        ─────────────────────────────────────────────────────────────────────
        This selected FROM t — the trip aggregate — so a day the driver was
        online for and never dispatched had no row at all, and neither did a
        day a statement paid them for that the trip feed missed. Those are two
        of the most informative days a driver has: one is availability that
        earned nothing, which is the question the panel above this table exists
        to answer, and the other is money arriving for work we cannot see.

        It also made the page disagree with itself. The KPI tile sums the
        stored record and the chart sums this endpoint, so a driver with an
        online day and no jobs had a tile reading 28 hours over a chart drawing
        24 — the same shape of contradiction as the window bug, from the other
        direction.

        A day arriving only through k lands with trips 0 and null hours of
        work, which is exactly what it was. */
     spine AS (
       SELECT day FROM t UNION SELECT day FROM k UNION SELECT day FROM h)
     SELECT to_char(spine.day, 'YYYY-MM-DD') AS day,
            coalesce(t.trips, 0) AS trips,
            coalesce(t.completed, 0) AS completed,
            coalesce(t.cancelled, 0) AS cancelled,
            coalesce(t.outcome_n, 0) AS outcome_n,
            t.km, t.revenue, t.first_trip_at, t.last_trip_at,
            t.first_hour, t.last_hour, t.span_h, t.plates, t.platforms,
            CASE WHEN h.hours_online IS NOT NULL THEN round(h.hours_online::numeric,2)
                 ELSE round(k.online_min::numeric/60,2) END AS hours_online,
            /* NULL, never 0, where availability was never collected: Uber is
               the only channel here that publishes it, so the hotel and Yango
               drivers have none — and zeroing them would report people who
               worked all month as never having logged in. */
            CASE WHEN h.hours_online IS NOT NULL THEN 'platform'
                 WHEN k.online_min IS NOT NULL THEN 'availability' END AS hours_online_basis,
            round(k.on_job_min::numeric/60,2) AS hours_on_job,
            round(k.idle_online_min::numeric/60,2) AS hours_idle_online,
            /* What the day was worth, from whichever feed measured it: the
               statement's net where a platform filed one, its fares where it
               did not, per platform and then summed (src/rollup.js:823).
               revenue beside it is fares only, which is null on every
               Uber-only day — 85 of this fleet's 119 active drivers. */
            round(k.money::numeric,2) AS money, k.money_source,
            k.money_period_days,
            /* Returned beside the money they decompose. A page that prints a
               total and its parts from two different endpoints will eventually
               print a total that is not the sum of the parts it shows. */
            k.stmt_gross, k.stmt_fees, k.stmt_net, k.cash, k.payout, k.payout_cash,
            round(h.earnings::numeric,2) platform_earnings,
            w.temp_max, w.precipitation, c.is_ramadan
     FROM spine LEFT JOIN t USING (day)
                LEFT JOIN h USING (day)
                LEFT JOIN k USING (day)
                LEFT JOIN weather_daily w ON w.day = spine.day
                LEFT JOIN calendar_day c ON c.day = spine.day
     ORDER BY spine.day`, p))));

  /* ── the day as it was actually spent ──────────────────────────────────
     The shift panel drew one solid bar per day, first trip to last trip, and
     called it "the working window". It is not a working window: a driver with
     eight trips between 05:19 and 23:10 was drawn identically to a driver who
     did eight back-to-back and went home, because a span says nothing about
     what happened inside it. On six drivers measured live for 25 August, the
     span was between 51% and 92% WAITING.

     So this returns the day's jobs at their real positions, and the page draws
     the gaps between them. Minutes since Dubai midnight, because that is the
     axis the bar is drawn on and converting in the browser puts the viewer's
     clock back into a chart whose whole subject is Dubai time.

     THREE THINGS IT REFUSES TO GUESS.

     1. A JOB WITH NO DROPOFF IS NOT A JOB OF LENGTH ZERO. Uber reports a
        dropoff time on most trips and none on the rest. Those come back with
        e = null and are drawn as an unknown, never folded into waiting —
        which would silently convert missing data into idleness.

     2. A JOB THAT RUNS PAST MIDNIGHT IS CLAMPED, AND SAYS SO. Minute-of-day
        wraps, so a dropoff at 00:20 the next morning is minute 20, which is
        BEFORE its own request. It is clamped to the end of the day and
        flagged, rather than drawn backwards.

     3. TIME CARRYING SOMEONE IS NOT SEPARABLE FROM TIME DRIVING TO THEM, and
        this was checked against the raw payloads rather than assumed. Uber's
        trip export carries fifteen fields and exactly two timestamps — 'Trip
        request time' and 'Trip drop-off time' (86% filled). There is no
        pickup time and no duration. The hotel channel carries startTime and
        endTime and the same gap. FMS is the only source with a 'Trip Duration'
        field, and FMS rows are telematics journeys rather than bookings, so
        they are excluded here by is_booking and cannot split anything.

        Request-to-dropoff is therefore ONE block containing the approach, the
        wait for the rider and the ride. It is labelled "on job" for exactly
        that reason, and the page says so rather than splitting it on an
        assumption about how long a Dubai pickup takes. */
  app.get('/api/driver/shift', withDriver(async (req, res, d, p) => {
    const MIN = (col) => `(extract(hour FROM ${col} AT TIME ZONE 'Asia/Dubai') * 60`
      + ` + extract(minute FROM ${col} AT TIME ZONE 'Asia/Dubai'))::int`;
    const rows = await q(
      `SELECT to_char((requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
              ${MIN('requested_at')} AS s,
              CASE WHEN ended_at IS NULL THEN NULL ELSE ${MIN('ended_at')} END AS e,
              /* Did the dropoff land on a LATER Dubai day than the request?
                 Written as a comparison against the request's day + 1 rather
                 than as a second ::date cast, because a cast on ended_at is a
                 Dubai-day filter expression that no index serves — and
                 test/indexes.test.mjs is right to flag every one of them, even
                 the ones that are only ever selected. */
              (ended_at IS NOT NULL
               AND (ended_at AT TIME ZONE 'Asia/Dubai')
                 >= ((requested_at AT TIME ZONE 'Asia/Dubai')::date + 1)) AS past_midnight,
              platform, plate, outcome
         FROM trip_norm
        WHERE ${TW} AND is_booking
        ORDER BY 1, 2`, p);

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(r);
    }
    const out = [...byDay.entries()].map(([day, list]) => {
      const jobs = list.map((r) => {
        const s = r.s;
        /* Clamped, not wrapped — but only for the case that means what the
           clamp says.
           ─────────────────────────────────────────────────────────────────
           A dropoff after midnight is minute 20 of the NEXT day, which as a
           raw number sits before its own request; running it to 1440 is right.

           A dropoff before its own request on the SAME Dubai day is not that.
           It is a bad timestamp, and this line ran it to 1440 as well — a
           twenty-four hour job. On the operator's own driver, eleven such rows
           contributed 40.4 hours of the 125.8 this endpoint reported for
           August, against 87.7 in the stored record: a page telling somebody
           they were on job for five days straight. src/rollup.js:711 already
           makes the right call for the same rows — greatest(end, start), a
           job of zero known length — and the two are now the same rule, which
           is the only way the panel and the record it is drawn beside can
           agree. `over` still marks the row either way; a bad timestamp is
           worth seeing. */
        const e = r.e == null ? null : (r.past_midnight ? 1440 : Math.max(r.e, s));
        return { s, e, over: Boolean(r.past_midnight) || (r.e != null && r.e < s),
          platform: r.platform, plate: r.plate, outcome: r.outcome };
      });
      let onJob = 0, unknown = 0, overlaps = 0, wait = 0, longest = 0;
      let cursor = null;
      for (const j of jobs) {
        if (j.e == null) { unknown += 1; continue; }
        onJob += Math.max(0, j.e - j.s);
        if (cursor != null) {
          const gap = j.s - cursor;
          if (gap < 0) overlaps += 1;
          else { wait += gap; longest = Math.max(longest, gap); }
        }
        cursor = Math.max(cursor ?? j.e, j.e);
      }
      const known = jobs.filter((j) => j.e != null);
      const first = jobs.length ? Math.min(...jobs.map((j) => j.s)) : null;
      const last = known.length ? Math.max(...known.map((j) => j.e)) : first;
      return { day, jobs, bookings: jobs.length, on_job_min: onJob, wait_min: wait,
        longest_wait_min: longest, overlaps, unknown_end: unknown,
        first_min: first, last_min: last,
        span_min: first == null || last == null ? null : Math.max(0, last - first) };
    }).sort((x, y) => (x.day < y.day ? -1 : 1));

    /* ── was the gap ONLINE or OFF? ──────────────────────────────────────
       The waiting band is 81% of this panel and said nothing: a driver sitting
       at a rank with the app on and a driver who logged off and went home drew
       the same colour. One is supply the fleet is paying for and failing to
       sell; the other is somebody's evening.

       Spans are derived here rather than stored, because the collector records
       transitions (sql/schema_v37.sql) — a span is a pair of them, and storing
       pairs means deciding at write time what a dangling ONLINE means and
       re-deciding it when its OFFLINE arrives on the next run.

       Clamped to the Dubai day, and a span crossing midnight is emitted on
       both days it touches: an evening shift is one span in the data and two
       bars on the chart. */
    /* Built by api/online_span_sql.js rather than here.
       ─────────────────────────────────────────────────────────────────────
       The CTE this replaces filtered `next_at IS NOT NULL`, which drops the
       most recent ONLINE — and Uber sends ONLINE as a repeated heartbeat that
       STOPS while a driver is on a job, so the dropped event is the one
       immediately before the work. Measured on production 2026-09-10: 60 of
       89 drivers sat on a dangling ONLINE, 56 of them dated that day, and
       7,518 minutes of availability disappeared from it. The module also
       unions the kind='job' intervals in, because Uber does not dispatch an
       offline driver and those intervals cover exactly the stretches where the
       heartbeat goes quiet.

       The fetch still reaches a day either side of the window. A span is
       opened by one event and closed by the NEXT, so the ONLINE at 23:40 on
       the day before the window is what makes the window's first morning
       online at all, and clipping the fetch to the window threw that event
       away along with the lead() that needed it. The bound is a Dubai-day
       bound, not `$1::timestamptz`, which bound the first day at UTC midnight
       — 04:00 Dubai — and drew the opening four hours of it as offline.

       span_start/span_end, not s/e, and the module keeps those names for the
       same reason this query did: test/indexes.test.mjs reads every Dubai-day
       cast in api/ as a column that needs an index, rightly, and a one-letter
       alias is indistinguishable from a real column to that check and to a
       reader.

       The days CTE clamps each span to the Dubai days it actually covers, and
       days outside the window fall out at the join below, which reads only the
       days already drawn. */
    const online = await q(
      `WITH ${onlineSpansSql({ where: `driver_ext_id = ANY($3)
              AND at >= (($1::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
              AND at <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')` })},
       days AS (
         SELECT generate_series((span_start AT TIME ZONE 'Asia/Dubai')::date,
                                (span_end AT TIME ZONE 'Asia/Dubai')::date,
                                interval '1 day')::date AS d,
                span_start, span_end, open_ended, closed_by
           FROM spans)
       SELECT to_char(d, 'YYYY-MM-DD') AS day,
              /* FLOOR, NOT A BARE ::int — Postgres rounds an int cast, and
                 every other minute-of-day figure on this response floors:
                 collected_to_min uses floor(), last_event_min is
                 hour*60+minute. That mismatch was invisible until closed_by
                 asserted the band's right edge IS the collection reach, and
                 then it printed the SAME INSTANT two ways — measured on
                 production 2026-09-10, a run finishing 13:17:52 rendered a
                 band ending 798 (13:18) beside a caption reading "last reached
                 13:17". One minute, and it is still the page contradicting
                 itself about one moment. A minute of the day is a floor: at
                 13:17:52 you have completed 797 whole minutes, not 798. */
              floor(greatest(0, extract(epoch FROM (
                greatest(span_start AT TIME ZONE 'Asia/Dubai', d::timestamp)
                - d::timestamp))/60))::int AS s,
              floor(least(1440, extract(epoch FROM (
                least(span_end AT TIME ZONE 'Asia/Dubai', d::timestamp + interval '1 day')
                - d::timestamp))/60))::int AS e,
              /* Only on the day the span actually runs out on. A shift that
                 crosses midnight is one span and two bars, and the earlier bar
                 ends at 24:00 because the day does, not because the record
                 does. Written as a bound on the whole day rather than as a
                 date equality so that a span closed exactly AT midnight — what
                 a dangling ONLINE on a past day is closed at — still marks the
                 day it was actually drawn on. */
              (open_ended
               AND (span_end AT TIME ZONE 'Asia/Dubai') <= d::timestamp + interval '1 day')
                AS open_ended,
              CASE WHEN open_ended
                    AND (span_end AT TIME ZONE 'Asia/Dubai') <= d::timestamp + interval '1 day'
                   THEN closed_by END AS closed_by
         FROM days
        ORDER BY 1, 2`, p);          // same $1..$3 order as TW, deliberately

    const onlineByDay = new Map();
    for (const r of online) {
      if (r.e <= r.s) continue;                 // a span that ends where it starts
      if (!onlineByDay.has(r.day)) onlineByDay.set(r.day, []);
      /* open_ended travels with the span: a bar that stops because the record
         stops is not the same claim as one that stops because the driver went
         offline, and only the caller can decide how to draw the difference. */
      onlineByDay.get(r.day).push({ s: r.s, e: r.e,
        open_ended: r.open_ended, closed_by: r.closed_by });
    }
    /* Attached to the day rows the chart already draws, and only where the day
       HAS availability: a day with none must render as it always did rather
       than as a day the driver was offline for, which is a different claim and
       one the absence of data cannot support. */
    for (const day of out) day.online = onlineByDay.get(day.day) || null;
    /* Days the collector has covered at all, so the caption can say "no data
       yet" instead of the chart implying everyone was logged out. */
    const covered = out.filter((x) => x.online).length;

    res.json({
      days: out,
      /* Stated once, by the API, so every renderer says the same thing rather
         than each inventing its own caption. */
      basis: 'A job runs from the request to the dropoff, so it contains the drive to the '
        + 'rider and the wait for them as well as the ride itself. Uber\'s export carries two '
        + 'timestamps and no pickup time, and the hotel channel the same, so the ride cannot '
        + 'be separated from the approach on any booking channel.',
      /* Uber serves 31 days of availability and nothing older, so this fills in
         from the day the collector started and can never be backfilled past
         it. Said here rather than left for a reader to infer from a chart that
         is bare on the left. */
      online_basis: covered
        ? 'The lighter band is time the driver was ONLINE on Uber between jobs — available and '
          + 'not dispatched. Where a day has no band, availability was not collected for it: '
          + 'Uber serves only the last 31 days, so this fills in going forward.'
        : 'Uber availability has not been collected for this driver yet. It arrives on a '
          + 'three-hourly pull and covers at most the last 31 days.',
      online_days: covered,
      unknown_end: out.reduce((a, x) => a + x.unknown_end, 0),
    });
  }));

  /* ── the KEPT per-day record ──────────────────────────────────────────
     driver_day (sql/schema_v38.sql) rather than a fold over raw. The point of
     the table is that it answers ranges the providers no longer serve: Uber
     gives 31 days of availability and about 192 of earnings, and this row
     survives both. It is also the only place idle-online exists as a stored
     fact rather than as a subtraction done at read time.

     Summed across a person's ACCOUNTS. The table is keyed on one driver id and
     a person can hold several; resolve() returns the match set, and a day this
     person worked on two accounts is one day of theirs. */
  app.get('/api/driver/days', withDriver(async (req, res, d, p) => {
    const rows = await q(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day,
              min(fleet_id) AS fleet_id,
              sum(trips)::int AS trips,
              sum(completed)::int AS completed,
              sum(cancelled)::int AS cancelled,
              round(sum(km)::numeric, 1) AS km,
              round(sum(fares)::numeric, 2) AS fares,
              min(first_min)::int AS first_min,
              max(last_min)::int AS last_min,
              sum(on_job_min)::int AS on_job_min,
              sum(wait_min)::int AS wait_min,
              max(longest_wait_min)::int AS longest_wait_min,
              /* NULL where no account has availability for the day, which is
                 not the same as zero — sum() over all-NULL is NULL, which is
                 the behaviour wanted here and the reason this is not a
                 coalesce. */
              sum(online_min)::int AS online_min,
              sum(idle_online_min)::int AS idle_online_min,
              max(computed_at) AS computed_at
         FROM driver_day
        WHERE driver_ext_id = ANY($3)
          AND day BETWEEN $1::date AND $2::date
        GROUP BY day
        ORDER BY day`, p);
    const covered = rows.filter((r) => r.online_min != null);
    /* When this record was last written, which is the difference between two
       numbers disagreeing and one of them being older.
       ─────────────────────────────────────────────────────────────────────
       Swept across all 119 active drivers after the window fix, /api/driver/kpis
       and this endpoint agree on 115 of them exactly. The other four differ by
       one trip, all on TODAY, because the rollup runs after a collection and
       the trip feed has moved since. That is the table working as designed —
       and indistinguishable, on the page, from the arithmetic being wrong.
       A reader comparing 285 against 284 needs to know one of them is as of
       09:13. */
    /* `a == null ||` first, and it is not defensive noise: `'2026-…' > null`
       coerces the string to NaN and is false, so a reduce seeded with null
       over string timestamps returns null for ever. It happens to work here
       because pg hands back Date objects, and it silently did not in the mock
       beside it, which is the kind of difference that makes a fixture stop
       testing anything. */
    const computed = rows.reduce(
      (a, r) => (r.computed_at && (a == null || r.computed_at > a) ? r.computed_at : a), null);
    res.json({
      days: rows,
      computed_at: computed,
      basis: 'One row per day, written after every collection and kept. Uber serves 31 days of '
        + 'availability and about 192 of earnings; these rows outlive both.',
      online_days: covered.length,
      totals: {
        computed_at: computed,
        days: rows.length,
        trips: rows.reduce((a, r) => a + (+r.trips || 0), 0),
        on_job_min: rows.reduce((a, r) => a + (+r.on_job_min || 0), 0),
        wait_min: rows.reduce((a, r) => a + (+r.wait_min || 0), 0),
        online_min: covered.reduce((a, r) => a + (+r.online_min || 0), 0),
        idle_online_min: covered.reduce((a, r) => a + (+r.idle_online_min || 0), 0),
      },
    });
  }));

  /* ── one driver, one day, minute by minute ────────────────────────────
     "How the day was spent" answers the shape of a month. This answers a day:
     every job at its real time with where it went, and — the part that was
     missing — what happened in the GAPS. A driver page could say somebody
     waited 7h 36m and could not say whether they were online, where they sat,
     or whether they moved while they waited.

     Three feeds joined on one clock:
       trip                     the jobs, with addresses, tier and payment
       driver_timeline_event    ONLINE spans (sql/schema_v37.sql)
       telemetry_snapshot       where the car was during each gap

     The telematics side is keyed by PLATE, not by driver, so it is reached
     through the custody record for that day — which is also why a gap can come
     back with no position at all and must say so rather than drawing nothing. */
  app.get('/api/driver/day', withDriver(async (req, res, d) => {
    const day = String(req.query.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ error: 'a day is addressed as YYYY-MM-DD' });
    }
    /* Dubai bounds for the calendar day, built once and reused by all three
       queries so they cannot disagree about where the day starts. */
    const p = [d.keys, day];

    const trips = await q(
      `SELECT external_id, platform, fleet_id, plate,
              requested_at, ended_at, status, outcome,
              distance_km, price, currency, product, payment_type,
              pickup_addr, dropoff_addr,
              (extract(hour FROM requested_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM requested_at AT TIME ZONE 'Asia/Dubai'))::int AS s,
              CASE WHEN ended_at IS NULL THEN NULL ELSE
                (extract(hour FROM ended_at AT TIME ZONE 'Asia/Dubai') * 60
                 + extract(minute FROM ended_at AT TIME ZONE 'Asia/Dubai'))::int END AS e,
              (ended_at IS NOT NULL
               AND (ended_at AT TIME ZONE 'Asia/Dubai') >= (($2::date) + 1)) AS past_midnight
         FROM trip_norm
        WHERE ${PKEY} = ANY($1) AND is_booking
          AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $2::date
        ORDER BY requested_at`, p);

    /* ONLINE spans clipped to this Dubai day. A shift that starts at 21:00 and
       ends at 03:00 is one span in the data and belongs to two days; this asks
       only for the part inside the day being drawn.

       THIS IS THE QUERY THE DEFECT WAS MEASURED ON.
       ─────────────────────────────────────────────────────────────────────
       It filtered `next_at IS NOT NULL`, which drops the last ONLINE — the one
       whose successor has not arrived. Uber sends ONLINE as a repeated
       heartbeat and stops sending it while a driver is on a job, so the
       dropped event is the one immediately before the work. Driver
       369dd9c1-ae0a-4526-8d46-d91a8c217121 on 2026-09-10 went online at
       09:59:15 and was dispatched six seconds later; this page drew him online
       08:35→09:59 and then printed "99% of online time", dividing 83 minutes
       of job time taken from the WHOLE day into an 84-minute window that
       stopped before two of his three trips. Fleet-wide that day: 60 of 89
       drivers on a dangling ONLINE, 7,518 minutes dropped.

       api/online_span_sql.js now owns the definition — it keeps the dangling
       ONLINE, closes it at the earlier of now() and the end of its own Dubai
       day, marks it open_ended, and unions in the kind='job' intervals, which
       are proof of being online for exactly the stretches the heartbeat does
       not cover. */
    const online = await q(
      `WITH ${onlineSpansSql({ where: `driver_ext_id = ANY($1)
              AND at >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
              AND at <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')` })}
       SELECT
              /* FLOOR, NOT A BARE ::int — Postgres rounds an int cast, and
                 every other minute-of-day figure on this response floors:
                 collected_to_min uses floor(), last_event_min is
                 hour*60+minute. That mismatch was invisible until closed_by
                 asserted the band's right edge IS the collection reach, and
                 then it printed the SAME INSTANT two ways — measured on
                 production 2026-09-10, a run finishing 13:17:52 rendered a
                 band ending 798 (13:18) beside a caption reading "last reached
                 13:17". One minute, and it is still the page contradicting
                 itself about one moment. A minute of the day is a floor: at
                 13:17:52 you have completed 797 whole minutes, not 798. */
              floor(greatest(0, extract(epoch FROM (
                greatest(span_start AT TIME ZONE 'Asia/Dubai', $2::timestamp)
                - $2::timestamp))/60))::int AS s,
              floor(least(1440, extract(epoch FROM (
                least(span_end AT TIME ZONE 'Asia/Dubai', $2::timestamp + interval '1 day')
                - $2::timestamp))/60))::int AS e,
              /* Open-ended only where the span really runs out inside this day.
                 A span that merely crosses the day's far edge is clipped at
                 24:00 because the day ends, which is not a claim about the
                 driver. */
              (open_ended
               AND (span_end AT TIME ZONE 'Asia/Dubai') <= $2::timestamp + interval '1 day')
                AS open_ended,
              /* And WHICH bound closed it — 'collection' where the span stops
                 at the last moment we actually asked Uber, 'now' where it is
                 still running as far as we know, 'day' where only the calendar
                 stopped it. Carried only on the spans that are open-ended in
                 this day, because for the rest there is nothing to explain. */
              CASE WHEN open_ended
                    AND (span_end AT TIME ZONE 'Asia/Dubai') <= $2::timestamp + interval '1 day'
                   THEN closed_by END AS closed_by
         FROM spans
        WHERE span_end > (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND span_start < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
        ORDER BY 1`, p);

    /* HOW MUCH OF THIS DAY HAS ACTUALLY BEEN ASKED ABOUT.
       ─────────────────────────────────────────────────────────────────────
       The timeline collector runs on UBER_TIMELINE_CRON (src/settings.js:53),
       which ships as every three hours. Trips arrive on the half-hourly
       incremental. So the last few hours of today are routinely not fetched
       yet, and the page has no way to tell that from a driver who stopped.

       It is not a corner case. Driver 369dd9c1-ae0a-4526-8d46-d91a8c217121 on
       2026-09-10: his timeline events stop at 10:05:46 and the 10:44 trip he
       went on to make has no timeline events at all. Drawn without this, the
       band simply ends and the reader concludes he went home. The same
       distinction is what api/online_routes.js calls `awaiting_feed`, and it
       reads the same row of collection_run to say it.

       Two clocks, because they answer two different questions. The FEED's last
       run bounds what anybody could know about this day; this DRIVER's last
       event is the sharper statement where it is earlier still. status <>
       'error' rather than status = 'ok', so a partial run — which did collect
       something — still counts as having reached the day. */
    const [feed] = await q(
      /* SCOPED TO THIS PERSON'S OWN FLEETS, because the ceiling that bounds
         their online band is (api/online_span_sql.js). The collector runs per
         fleet and files a collection_run row per fleet, so a global max()
         here would print "collected to 22:17" beside a band that stops at
         10:17 because that is when THIS fleet was last asked — the page
         contradicting itself in two adjacent sentences.

         Falls back to the feed as a whole when we hold no timeline events for
         this person at all: then there is no fleet to scope to, and the
         question "has the collector reached this day" still has an answer. */
      `WITH fl AS (
         SELECT DISTINCT fleet_id FROM driver_timeline_event
          WHERE driver_ext_id = ANY($1))
       SELECT max(finished_at) AS last_run_at,
              greatest(0, least(1440, floor(extract(epoch FROM (
                least(max(finished_at), (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai'))
                - (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')))/60)))::int
                AS collected_to_min
         FROM collection_run
        WHERE source = 'uber_timeline' AND status <> 'error'
          AND finished_at IS NOT NULL
          AND (NOT EXISTS (SELECT 1 FROM fl)
               OR fleet_id IN (SELECT fleet_id FROM fl))`, p);
    const [reach] = await q(
      `SELECT max(at) AS last_event_at,
              max((extract(hour FROM at AT TIME ZONE 'Asia/Dubai') * 60
                   + extract(minute FROM at AT TIME ZONE 'Asia/Dubai'))::int) AS last_event_min,
              array_remove(array_agg(DISTINCT platform), NULL) AS platforms
         FROM driver_timeline_event
        WHERE driver_ext_id = ANY($1)
          AND at >= (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`, p);

    /* The day is finished only when a collection ran AFTER it ended. Anything
       short of that leaves a tail nobody has asked Uber about, and the size of
       that tail is the thing the page has to be able to name. */
    const collectedTo = feed?.collected_to_min ?? null;
    const collectedFull = feed?.last_run_at != null && collectedTo >= 1440;
    const collection = {
      source: 'uber_timeline',
      /* The cadence in words, read from the setting rather than written into
         the sentence. An operator can change UBER_TIMELINE_CRON without a
         deploy, and a hard-coded "every three hours" would go on being printed
         after they did. The cron expression itself never reaches the page —
         it is a configuration key, and this file's own house rule is that a
         raw key is never the right thing to show a reader. */
      every_hours: cronEveryHours(config.uberTimelineCron),
      last_run_at: feed?.last_run_at || null,
      /* Minute of this Dubai day the feed has reached, clamped to the day. 1440
         means a pass finished after the day ended, so the day is closed. */
      collected_to_min: feed?.last_run_at ? collectedTo : null,
      last_event_at: reach?.last_event_at || null,
      last_event_min: reach?.last_event_at ? reach.last_event_min : null,
      /* Which channels have an availability record at all. Only Uber files one
         — src/sources/uber_timeline.js is the sole writer of the table — but it
         is read off the rows rather than asserted, so a second channel filing
         one tomorrow does not leave this sentence lying. */
      platforms: reach?.platforms || [],
      complete: collectedFull,
      why: null,
    };
    if (!feed?.last_run_at) {
      collection.why = 'Uber\u2019s driver timeline has never been collected, so nothing on this '
        + 'day is evidence about whether anybody was online.';
    } else if (!collectedFull) {
      const left = 1440 - collectedTo;
      const every = collection.every_hours;
      collection.why = 'This day is still being collected. The availability feed'
        + (every ? ` runs every ${every === 1 ? 'hour' : `${every} hours`} and` : '')
        + ` last reached ${String(Math.floor(collectedTo / 60)).padStart(2, '0')}:`
        + `${String(collectedTo % 60).padStart(2, '0')}, so the remaining `
        + `${Math.floor(left / 60)}h ${String(left % 60).padStart(2, '0')}m of the day has not `
        + 'been fetched yet. A band that stops there is the record stopping, not necessarily '
        + 'the driver.';
    }

    /* Where the car was, minute-bucketed. Returned as fixes rather than as
       per-gap rollups because the gaps are computed on the client from the
       jobs, and doing it twice in two places is how the two stop agreeing. */
    const plates = [...new Set(trips.map((t) => t.plate).filter(Boolean))];
    /* Every fix carries the name of the ground it sits on, joined out of the
       gazetteer (sql/schema_v67.sql). A decimal pair is not an answer to
       "where was the car waiting" — nobody reads 25.112, 55.139 and pictures
       Jumeirah Lakes Towers — and no provider gives us both a fix and a name:
       Uber has 315,505 addresses and no coordinates, FMS has 222,543
       coordinates each with an address beside it. place_cell is that second
       set, folded to half-kilometre cells.

       LEFT JOIN, and the count of votes comes back with the name, because a
       cell one trip named is not the same claim as a cell four hundred trips
       agree on and the page has to be able to say which it is holding. A cell
       nothing has ever named returns NULL and renders as unnamed. */
    const fixes = plates.length ? await q(
      `SELECT s.plate,
              (extract(hour FROM s.captured_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM s.captured_at AT TIME ZONE 'Asia/Dubai'))::int AS m,
              s.lat, s.lng, s.speed,
              pc.area, pc.n AS area_votes, pc.observations AS area_seen
         FROM telemetry_snapshot s
         LEFT JOIN place_cell pc
           ON pc.cell_lat = round(s.lat / 0.005)::int
          AND pc.cell_lng = round(s.lng / 0.005)::int
        WHERE s.plate = ANY($1)
          AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date = $2::date
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        ORDER BY s.captured_at`, [plates, day]) : [];

    /* WHERE the shift began, which Uber will not tell us.
       ─────────────────────────────────────────────────────────────────────
       "Where does this person go online" is the question an operator asks
       about supply, and driver_timeline_event has a lat/lon column for it.
       Measured on production 2026-09-07: 197,687 timeline events and lat is
       null on every single one, even though the collector's GraphQL query asks
       for rootLocation. Uber accepts the field and returns nothing in it.

       So the position comes from the other side of the same car. The tracker
       reports the plate every few minutes all day; the fix nearest in time to
       the moment the driver went online is where they were when they did it,
       and the gazetteer names it.

       Nearest IN TIME, with the gap reported rather than hidden — a fix four
       minutes before the span is a good answer and a fix fifty minutes before
       is not the same claim. Beyond half an hour there is no honest answer at
       all and the span says so instead of borrowing a distant fix. */
    const ONLINE_FIX_TOLERANCE_MIN = 30;
    const namedFixes = fixes.filter((f) => f.area);
    const placeAt = (minute) => {
      if (!fixes.length) {
        return { where: null, why: plates.length
          ? 'the tracker recorded no position for this car on this day'
          : 'no vehicle is attached to this day, so there is no position feed' };
      }
      if (!namedFixes.length) {
        return { where: null, why: 'the tracker saw the car, but no trip has ever named this ground' };
      }
      let best = null;
      for (const f of namedFixes) {
        const gap = Math.abs(f.m - minute);
        if (!best || gap < best.gap) best = { gap, f };
      }
      if (!best || best.gap > ONLINE_FIX_TOLERANCE_MIN) {
        return { where: null, why: `the nearest named position is ${best.gap} minutes away, too far to call it the same place` };
      }
      return {
        where: best.f.area,
        within_min: best.gap,
        lat: best.f.lat,
        lng: best.f.lng,
        votes: best.f.area_votes,
        of: best.f.area_seen,
        why: null,
      };
    };

    /* One row per span, so a shift split by a break reads as two starts rather
       than one — where somebody comes back online is as much a supply fact as
       where they started. */
    const onlinePlaced = online.map((o) => ({ ...o, went_online: placeAt(o.s) }));

    /* And the summary the page leads with: the areas this person actually
       started from, most used first. Counted over spans, not over minutes: the
       question is how often they choose that place, not how long they stayed. */
    const startTally = new Map();
    for (const o of onlinePlaced) {
      const a = o.went_online?.where;
      if (!a) continue;
      startTally.set(a, (startTally.get(a) || 0) + 1);
    }
    const goesOnlineIn = [...startTally.entries()]
      .map(([area, spans]) => ({ area, spans }))
      .sort((a, b) => b.spans - a.spans || a.area.localeCompare(b.area));

    res.json({
      day,
      driver: { id: d.driver_ext_id, name: d.name, keys: d.keys },
      trips: trips.map((t) => ({
        ...t,
        /* Clamped, not wrapped: a dropoff after midnight is minute 20 of the
           NEXT day, which as a raw number sits before its own request. A
           dropoff before its own request on the SAME day is a bad timestamp,
           not a day-long job — the same rule as the shift fold above and as
           src/rollup.js:711. */
        e: t.e == null ? null : (t.past_midnight ? 1440 : Math.max(t.e, t.s)),
      })),
      online: onlinePlaced,
      /* What has and has not been asked about, so a band that stops early can
         say which of the two it is. See the query above. */
      collection,
      fixes,
      /* Which areas this person went online in today, and how many of the
         day's spans could not be placed at all — never a list that quietly
         omits what it could not answer. */
      goes_online_in: goesOnlineIn,
      online_spans_unplaced: onlinePlaced.filter((o) => !o.went_online?.where).length,
      /* What the place names are and are not, said once by the API so every
         renderer says the same thing. */
      place_basis: 'Uber returns no coordinates — not on trips, not on the online timeline — so where '
        + 'someone went online is read from the tracker in the same car, at the fix nearest in time. '
        + 'The area name comes from the fleet\'s own history: every FMS trip arrives with both a '
        + 'position and an address, and those pairs name the ground within about half a kilometre.',
      /* Said by the API so every renderer says the same thing. */
      basis: 'A job runs from the request to the dropoff, so it contains the drive to the rider. '
        + 'The gaps between jobs are waiting; where the tracker saw the car during one, its '
        + 'position and how much of it was stationary are shown against that gap.',
      online_known: online.length > 0,
    });
  }));

  /* ── weekday × hour: when this person actually works ───────────────── */
  app.get('/api/driver/heatmap', withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT extract(dow from requested_at AT TIME ZONE 'Asia/Dubai')::int dow,
            extract(hour from requested_at AT TIME ZONE 'Asia/Dubai')::int h,
            count(*)::int trips, round(sum(price)::numeric,0) revenue
     FROM trip WHERE ${TW} GROUP BY 1,2 ORDER BY 1,2`, p))));

  /* ── standing against the fleet, as percentiles ────────────────────── */
  /* Percentile answers "where does this driver sit", which a raw number never
     does. Anyone with fewer than 5 trips in the window is excluded from the
     comparison set — otherwise a single-trip driver distorts every rank.

     THE FLOOR IS ON THE PERSON, and for a year it was on the ACCOUNT.
     ─────────────────────────────────────────────────────────────────────────
     The sentence above says "anyone", the page says "every driver with 5 or
     more trips in this window", and the SQL said `GROUP BY 1 HAVING count(*)
     >= 5` — keyed on one provider account, evaluated before the fold three
     hundred lines below that turns a person's several accounts into one row.
     A person with four accounts of three trips has twelve trips and was not in
     the cohort at all.

     Measured on production 2026-09-01..09-07, then RE-measured after the fix,
     because the first comparison was between two different things:

       /api/drivers/directory rows with 5+ bookings            104
       …of which are a SECOND row for a person already listed    6
       distinct people                                          98
       n_peers this endpoint reported                           97
       n_peers it reports now                                   98

     The 104 is a row count, not a headcount. The directory keys on the
     provider ACCOUNT — coalesce(nullif(btrim(driver_ext_id), ''), 'name:' ||
     person_key), :450 — so six people appear on two rows apiece with the SAME
     person_key printed on both. Subtract those and the folded population is
     98, which is exactly what this endpoint returns once its floor stops
     running per account. On a one-day window there is nothing to subtract and
     the two agree outright: 2026-09-06 went 51 → 53 against the directory's 53.

     So one person was missing from that week's cohort, not seven. One is
     enough, because of what the page then told him.

     Muhammad Asif Amir Zada (6640364) is one of them: 5 trips over 3 accounts,
     none of them reaching 5, so /api/driver/standing returned metrics [] and
     api/public/driver.js:688 printed "5 trips in this window, which is fewer
     than the five a ranking needs". Five is not fewer than five. The page
     stated a false arithmetic fact about a named person because the count it
     was comparing came from a different grain than the count it printed.

     The floor now runs after the fold, over the same population the
     percentiles are taken over, which is what every sentence about it already
     claimed. */
  app.get('/api/driver/standing', withDriver(async (req, res, d, p) => {
    const peers = await q(
      `SELECT ${PKEY} AS driver_ext_id,
              /* The NAME as well as the key, because the key is an ACCOUNT and
                 the cohort below has to be people — see the fold underneath
                 this query. max() over a group whose key is the provider id:
                 one id, one person, whichever spelling the feed used. */
              max(driver_name) AS driver_name,
              count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days,
              sum(distance_km) km, sum(price) revenue,
              avg(distance_km) FILTER (WHERE has_distance) avg_km,
              100.0*count(*) FILTER (WHERE outcome='completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) completion,
              100.0*count(*) FILTER (WHERE outcome='not_completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) cancel
       FROM trip_norm
       -- The SAME window rule as TW above, and it has to be: this ranks the
       -- driver against the cohort, and a cohort measured over a window four
       -- hours longer than the driver's own is a comparison between two
       -- different Augusts.
       WHERE ${DAYWIN('requested_at')}
         -- keyed on the person, so a named driver with no id is a peer like
         -- anyone else instead of being quietly left out of the cohort they
         -- are being ranked against
         AND (coalesce(btrim(driver_ext_id), '') <> '' OR coalesce(btrim(driver_name), '') <> '')
       /* No HAVING. The five-trip floor is applied to the FOLDED population
          below, because the floor is a statement about a person and this
          GROUP BY is keyed on an account. See the block above the route. */
       GROUP BY 1`, [p[0], p[1]]);
    // The peers query projects the PERSON KEY, so the match set is the one to
    // compare against — the account list would miss their id-less rows.
    const mineIds = new Set(d.keys);

    /* Peer values folded to one per person, which is what this claimed to do
       and did not.
       ─────────────────────────────────────────────────────────────────────
       The key it folded on was PKEY — a provider id where there is one — so
       only the SUBJECT collapsed, through the '__me__' branch. Every other
       driver holding two platform accounts stayed as two rows: two mediocre
       halves of one person, in a population the page then calls "drivers".
       Measured on production 2026-09-04 at days=365 the page said 414 peers
       where /api/drivers/leaderboard counts 361 people who drove — more peers
       than there are drivers, and every percentile taken against that.

       personOf() is the product's own answer to "which human is this record":
       the three-record identity register first, then the name fold — the same
       one the driver directory folds on twelve hundred lines above, and the
       same one sql/schema_v53.sql stores. So the cohort now counts people the
       way every other headcount in this product counts them. An account nobody
       named keys on itself, which keeps it visible rather than merging every
       unnamed account into one ghost. */
    const folded = new Map();
    for (const r of peers) {
      const k = mineIds.has(r.driver_ext_id)
        ? '__me__' : (personOf(r.driver_ext_id, r.driver_name) || r.driver_ext_id);
      const c = folded.get(k) || { trips: 0, km: 0, revenue: 0, days: 0, _cw: 0, avg_km: 0, completion: 0, cancel: 0 };
      c.trips += r.trips; c.km += +r.km || 0; c.revenue += +r.revenue || 0;
      c.days = Math.max(c.days, r.days);
      c._cw += r.trips;
      c.avg_km += (+r.avg_km || 0) * r.trips;
      c.completion += (+r.completion || 0) * r.trips;
      c.cancel += (+r.cancel || 0) * r.trips;
      folded.set(k, c);
    }
    for (const c of folded.values()) {
      if (c._cw) { c.avg_km /= c._cw; c.completion /= c._cw; c.cancel /= c._cw; }
      c.trips_per_day = c.days ? c.trips / c.days : 0;
    }
    /* THE FLOOR, here, on the person — see the block above the route for the
       seven people the account-grain version left out and the false sentence
       it printed for one of them. FLOOR is named rather than inlined so the
       response can state the number it applied, which is the only way a page
       can say "five or more" without a copy of the five in its own source. */
    const FLOOR = 5;
    const pop = [...folded.values()].filter((c) => c.trips >= FLOOR);
    /* `me` is the subject's own folded row, not a second sum of the same
       numbers. It WAS a second sum — sum()/wavg() over `mine`, arithmetic
       identical to the fold and sitting fifteen lines from it — and two
       implementations of one figure is how a page comes to disagree with
       itself. One of them is now the only one.

       Read from `folded` rather than from `pop`, so a subject under the floor
       still has their own count to report in the branch below; `pop` is the
       comparison set and the subject is only in it when they qualify. */
    const me = folded.get('__me__');
    if (!me || me.trips < FLOOR) {
      /* n_peers meant two different things in the two branches: this one
         returned peers.length — the raw ACCOUNT count, 117 on production for
         2026-09-01..09-07 — while the ranked branch returned the folded people,
         97. The same field, the same window, twenty rows apart, depending only
         on whether the reader happened to be rankable. It is the cohort in
         both branches now.

         trips_in_window travels with it so the page can say the true number
         instead of deriving "fewer than five" from a count it fetched from a
         different endpoint at a different grain. */
      return res.json({ n_peers: pop.length, peer_floor: FLOOR,
        trips_in_window: me ? me.trips : 0, metrics: [] });
    }
    /* HOW MANY PEOPLE HOLD THE SAME VALUE, returned with the percentile.
       ───────────────────────────────────────────────────────────────────────
       A percentile of 0 means "nobody is below you". On a flat distribution
       that is not a low score, it is a tie — and the phones rendered it as
       `percentile <= 0 ? 'lowest in the fleet'` in the warn colour
       (api/public/m/screens.js:947). On any one-day window most drivers have
       days_worked 1, so the median is 1, so every one of them scored 0 and
       every one of them was told they were the worst in the fleet at a figure
       they shared with the majority.

       The percentile cannot express that on its own: 0 is 0 whether one person
       is at the bottom or ninety are level. So the SIZE of the tie travels
       with it and the renderers decide what is sayable — the API's job is to
       report the shape of the distribution, not to guess which sentence a
       given width wants. Exact equality is the right test: the metrics that
       actually tie are integer counts (days, bookings), and a float that ties
       to the last bit genuinely is the same measurement. */
    const pct = (key, higherIsBetter = true) => {
      const vals = pop.map((c) => +c[key] || 0).sort((a, b) => a - b);
      const v = +me[key] || 0;
      let below = 0; while (below < vals.length && vals[below] < v) below++;
      let tied = 0; for (const x of vals) if (x === v) tied++;
      const raw = vals.length > 1 ? (below / (vals.length - 1)) * 100 : 50;
      return { value: v, percentile: Math.round(higherIsBetter ? raw : 100 - raw),
        median: vals[Math.floor(vals.length / 2)],
        /* Both, so a reader of the response can compute the share without
           knowing n_peers is the same population — it is, and saying so twice
           is cheaper than a caller assuming it wrongly. */
        tied, population: vals.length };
    };
    res.json({
      n_peers: pop.length,
      peer_floor: FLOOR,
      trips_in_window: me.trips,
      metrics: [
        /* "Trips completed" was count(*), with no completion filter anywhere
           in the query — a count of BOOKINGS printed under the word completed,
           eight pixels below a Completion tile reading "81 of 95 completed,
           14 did not" for the same person and the same window. The row said 95.

           The measure is not changed: bookings taken is the workload rank this
           panel wants, and the panel already carries Completion rate and
           Cancellation rate as their own rows, taken over outcome. Only the
           name was wrong, and "Bookings" is the word the rest of this profile
           already uses for count(*) — the phone's header ("95 BOOKINGS IN THIS
           WINDOW"), its own tile, and countOf(n, 'booking') throughout ui.js. */
        { key: 'trips', label: 'Bookings', ...pct('trips') },
        { key: 'trips_per_day', label: 'Bookings a working day', ...pct('trips_per_day') },
        { key: 'km', label: 'Distance driven', ...pct('km') },
        { key: 'avg_km', label: 'Average trip length', ...pct('avg_km') },
        { key: 'days', label: 'Days worked', ...pct('days') },
        { key: 'completion', label: 'Completion rate', ...pct('completion') },
        { key: 'cancel', label: 'Cancellation rate', ...pct('cancel', false) },
        { key: 'revenue', label: 'Revenue booked', ...pct('revenue') },
      ].filter((m) => m.value || m.median),
    });
  }));

  /* ── territory: where they pick up, and where they wait ────────────── */
  app.get('/api/driver/territory', withDriver(async (req, res, d, p) => {
    const pickups = await q(
      `SELECT round(pickup_lat::numeric,4) lat, round(pickup_lng::numeric,4) lng,
              count(*)::int n, max(pickup_addr) addr,
              -- Inline, because this reads trip and not trip_norm, so
              -- has_distance is not in scope: the same three conditions the
              -- view's column is made of.
              round(avg(distance_km) FILTER (WHERE distance_km > 0 AND distance_km < 500)::numeric,1) avg_km,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_lat IS NOT NULL AND pickup_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    const dropoffs = await q(
      `SELECT round(dropoff_lat::numeric,4) lat, round(dropoff_lng::numeric,4) lng,
              count(*)::int n, max(dropoff_addr) addr
       FROM trip WHERE ${TW} AND dropoff_lat IS NOT NULL AND dropoff_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    /* Named areas, coarser than a coordinate — useful as a list next to the map.
       ─────────────────────────────────────────────────────────────────────
       split_part(addr, ' - ', 1) is the FIRST segment, which in
       "01 Cluster E - Al Thanyah Fifth - Dubai - UAE" is a house number. So
       the list read "12 Cluster E", "9 Marasi Dr", "Atlantis" — one row per
       building rather than per area, with trailing " &" fragments and
       non-Latin strings of their own. The second segment is the community, and
       it is the same expression #corridors and #slot use, imported rather than
       copied so all three name a place the same way. */
    const areas = await q(
      `SELECT coalesce(${areaOf('pickup_addr')}, '(unparsed)') area, count(*)::int n,
              round(avg(distance_km) FILTER (WHERE distance_km > 0 AND distance_km < 500)::numeric,1) avg_km,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_addr IS NOT NULL AND pickup_addr <> ''
       GROUP BY 1 ORDER BY n DESC LIMIT 25`, p);
    // Where the vehicle sat still between jobs — telemetry, not trips, so it is
    // only available for plates this driver held on days we have GPS for.
    const idle = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT round(s.lat::numeric,3) lat, round(s.lng::numeric,3) lng, count(*)::int fixes
       FROM telemetry_snapshot s JOIN days ON days.plate = s.plate
            AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       WHERE coalesce(s.speed,0) < 2 AND s.lat IS NOT NULL
       GROUP BY 1,2 HAVING count(*) >= 3 ORDER BY fixes DESC LIMIT 120`, p);
    /* The denominator the map is drawn over. One cluster on a map beside a
       table of 139 pickups across 25 areas is not a contradiction — most of
       this fleet's channels report no coordinate at all — but the page could
       not say so, and its "no positioned trips" note fired only at exactly
       zero. */
    const [cover] = await q(
      `SELECT count(*)::int bookings,
              count(*) FILTER (WHERE pickup_lat IS NOT NULL AND pickup_lat <> 0)::int positioned,
              count(*) FILTER (WHERE pickup_addr IS NOT NULL AND pickup_addr <> '')::int addressed,
              array_remove(array_agg(DISTINCT platform)
                FILTER (WHERE pickup_lat IS NULL OR pickup_lat = 0), NULL) AS unpositioned_platforms
       FROM trip_norm WHERE ${TW} AND is_booking`, p);
    res.json({
      pickups, dropoffs, areas, idle,
      coverage: {
        bookings: cover?.bookings ?? 0,
        positioned: cover?.positioned ?? 0,
        addressed: cover?.addressed ?? 0,
        positioned_pct: cover?.bookings
          ? Math.round((cover.positioned / cover.bookings) * 1000) / 10 : null,
        unpositioned_platforms: cover?.unpositioned_platforms || [],
      },
    });
  }));

  /* ── the shape of the work: distance, product, payment, outcome ────── */
  app.get('/api/driver/mix', withDriver(async (req, res, d, p) => {
    const bucket = await q(
      `SELECT CASE WHEN distance_km < 3 THEN '0–3 km'
                   WHEN distance_km < 7 THEN '3–7 km'
                   WHEN distance_km < 15 THEN '7–15 km'
                   WHEN distance_km < 30 THEN '15–30 km'
                   WHEN distance_km < 60 THEN '30–60 km'
                   ELSE '60 km+' END label,
              CASE WHEN distance_km < 3 THEN 1 WHEN distance_km < 7 THEN 2 WHEN distance_km < 15 THEN 3
                   WHEN distance_km < 30 THEN 4 WHEN distance_km < 60 THEN 5 ELSE 6 END ord,
              count(*)::int n, round(sum(price)::numeric,0) revenue,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND distance_km IS NOT NULL GROUP BY 1,2 ORDER BY ord`, p);
    const one = (col) => q(
      `SELECT coalesce(${col},'unknown') label, count(*)::int n, round(sum(price)::numeric,0) revenue
       FROM trip WHERE ${TW} GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    const [product, payment, status, platform] = await Promise.all(
      [one('product'), one('payment_type'), one('status'), one('platform')]);
    res.json({ distance: bucket, product, payment, status, platform });
  }));

  /* ── money: platform-reported components and the daily earnings line ─ */
  app.get('/api/driver/earnings', withDriver(async (req, res, d, p) => {
    const components = await q(
      `SELECT category, parent, round(sum(amount)::numeric,2) amount, currency
       FROM driver_earnings_component
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date
       GROUP BY 1,2,4 ORDER BY abs(sum(amount)) DESC`, p);
    /* The windows that actually contribute, not every window ever fetched.
       This listed driver_performance directly, and for one driver over six
       months that was sixty-seven rows for twenty-eight weeks of work —
       overlapping pairs six days apart, each a real answer to a slightly
       different question, presented as if they were consecutive periods. The
       reader could not add them up and neither could we. See
       sql/schema_v23.sql; "counted" is the part of the period this window
       covers, which is the whole of it unless a finer report overlaps it. */
    /* Counted means counted IN THIS WINDOW.
       ─────────────────────────────────────────────────────────────────────
       This read the driver_payout view, which sums every day of a period
       (sql/schema_v23.sql:147-167), and selected periods by OVERLAP — so a
       period running 2026-07-20 to 07-26 contributed all seven of its days to
       a window that opens on 07-26. On one load the tile read reported_earnings
       5,053.67 while the panel caption underneath it read "AED 6,592 counted
       across 11 statement(s)": AED 1,538 apart, from the same payload.

       driver_payout_day is already one row per day, so clamping is a matter of
       bounding the day rather than the period. `earnings` stays the whole
       period's figure — it is what the platform reported and the page shows it
       as the period's own total — and `counted` is now the part of it that
       falls inside the window, which is what the caption was always claiming
       to add up. */
    const periods = await q(
      `SELECT platform, period_start, period_end, period_days,
              count(*)::int AS days_used,
              min(day) AS first_day_used, max(day) AS last_day_used,
              round(max(period_earnings)::numeric,2) AS earnings,
              round(sum(earnings)::numeric,2) AS counted,
              round(sum(cash_earnings)::numeric,2) AS cash_earnings,
              round(sum(trips)::numeric,0)::int AS trips,
              round(sum(hours_online)::numeric,2) AS hours_online,
              round(sum(hours_on_trip)::numeric,2) AS hours_on_trip,
              /* True where the period straddles an edge of the window, so the
                 page can say the row is a slice rather than a statement. */
              (min(period_start) < $1::date OR max(period_end) > $2::date) AS clipped
       FROM driver_payout_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       GROUP BY platform, period_start, period_end, period_days
       ORDER BY period_start DESC LIMIT 120`, p);
    /* The two columns the earnings table draws and the payout table cannot
       supply. driver_payout_day is money and hours; acceptance and rating are
       driver_performance's, on the same (driver, period) key — so the page had
       an ACCEPT column and a RATING column that were structurally empty on
       every row of every driver. Joined here rather than deleted, because a
       payout period with an acceptance rate beside it is what makes a quiet
       week readable. */
    const perf = periods.length ? await q(
      `SELECT platform, period_start, period_end,
              max(acceptance_rate) AS acceptance_rate,
              max(cancellation_rate) AS cancellation_rate,
              max(rating) AS rating
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_end >= $1::date AND period_start <= $2::date
       GROUP BY 1,2,3`, p) : [];
    /* isoDay on both halves of the key, not String(...).slice(0, 10).
       ─────────────────────────────────────────────────────────────────────
       Both queries select bare DATEs: driver_payout_day.period_start and
       period_end (sql/schema_v23.sql:115-116), grouped above, and
       driver_performance's own pair (sql/schema.sql:88-89). Neither is wrapped
       in to_char, so node-postgres hands both sides JS Dates and String() made
       the key "uber|Wed Sep 02|Wed Sep 02" — a Date toString with the year cut
       off. The type is visible from outside: GET /api/driver/earnings for
       driver 76ede4ae…&days=90 serialises period_start as
       "2026-09-02T00:00:00.000Z", which is Express stringifying a Date, not a
       to_char string.

       It matched the right rows anyway, because BOTH sides lost the same year:
       that response holds 40 periods and exactly 1 carries acceptance_rate 1
       and rating 4.95, the 2026-08-03..08-09 week, which is the right answer —
       30 daily payout rows cannot match a weekly performance period on any
       key. Two distinct failures sat one edit away from that.

       ASYMMETRY. Add to_char to either query alone and one side reads
       "2026-08-03" while the other still reads "Mon Aug 03"; every key misses,
       and the ACCEPT and RATING columns of the earnings table go null on every
       row of every driver with no error to show for it. That is the case
       api/performer_routes.js:203 documents: two Dates compare fine, but only
       by luck.

       COLLISION, and this one needs no future edit. Dropping the year makes
       the key collide across years that align on the weekday: the weeks
       2019-10-01..10-07 and 2024-10-01..10-07 are both
       "uber|Tue Oct 01|Mon Oct 07". win() leaves from/to unclamped, so both
       fit in one window a caller can request now, the Map keeps whichever
       performance row it saw last, and the earnings table prints that week's
       rating and acceptance rate against the other week as well — a wrong
       number on the page, not merely a wrong key behind it.
       test/driver_day_keys.test.mjs drives both periods through the route and
       fails on the shared rating. */
    const perfKey = (r) => `${r.platform}|${isoDay(r.period_start)}|${isoDay(r.period_end)}`;
    const byPeriod = new Map(perf.map((r) => [perfKey(r), r]));
    for (const r of periods) {
      const m = byPeriod.get(perfKey(r));
      r.acceptance_rate = m?.acceptance_rate ?? null;
      r.cancellation_rate = m?.cancellation_rate ?? null;
      r.rating = m?.rating ?? null;
    }
    /* The resolved DAY table, not the raw components.
       ─────────────────────────────────────────────────────────────────────
       Uber now answers this driver on two surfaces at once — the REST payments
       feed on short periods and the supplier GraphQL breakdown on weeks — and
       a raw sum over components adds both readings of the same days together.
       Production shows it plainly: driver 64686123 carries a tip row of 35.00
       under your_earnings and another of 30.00 under earnings, for one week of
       work. Summed, the page reported AED 65.

       driver_statement_day is the same components with that collision already
       settled: one row per driver-day, taken from the FINEST period covering
       it (src/rollup.js). It is also what the reconciliation reads, so the
       driver page and the money pages now answer from one table. The window
       predicate is a day range rather than a period range, which is the other
       half of the fix: a week whose Monday fell outside the window used to
       drag all seven of its days in. */
    /* Matched on the NAME as well as the id, which is this table's own rule.
       ─────────────────────────────────────────────────────────────────────
       sql/schema_v25.sql:25 says it outright: "the name is the key — the ledger
       predates our ids and its people must not vanish for want of a match."
       driver_ext_id is nullable here and mostly null. Joined on the id alone
       this returned nothing, on every driver, while the same statements
       reconciled fine on the money pages — src/rollup.js:781 records the
       identical mistake being made and fixed against 2,375 driver-days and
       AED 330,343 of statements that the id join could not see.

       An OR rather than the coalesce PKEY uses, because either half is
       sufficient evidence: a row carrying one of this person's platform ids is
       theirs, and so is a row filed under their name with no id at all. Each
       row can only be counted once whichever arm matches it.

       btrim on name_key: the generated column collapses runs of whitespace but
       does not trim the ends (sql/schema_v25.sql:33), so a name filed with a
       leading space folds to " ali khan" and would miss a key built by
       canonSql, which trims. Cheap here — the day range bounds the scan. */
    const DSD_PERSON = `(driver_ext_id = ANY($3) OR 'name:' || btrim(name_key) = ANY($3))`;
    const [tips] = await q(
      `SELECT round(sum(tips)::numeric,2) tips, round(sum(net)::numeric,2) fare,
              /* The Cash column on this page carried a note saying no statement
                 separates the cash a driver already took from the net figure.
                 driver_statement_day.cash is sql/schema_v25.sql:41, and this
                 very query reads that table. Selected now, so the column can
                 stop apologising for a value that was there all along. */
              round(sum(cash)::numeric,2) cash,
              round(sum(gross)::numeric,2) gross,
              round(sum(fees)::numeric,2) fees,
              round(sum(salik)::numeric,2) salik,
              count(DISTINCT day)::int statement_days
       FROM driver_statement_day
       WHERE source <> 'ledger' AND NOT pseudo AND ${DSD_PERSON}
         AND day BETWEEN $1::date AND $2::date`, p);
    res.json({ components, periods,
      /* The sum the caption prints, computed here rather than left to the page
         to add up — the two disagreed by AED 1,538 in production. */
      counted_total: periods.length
        ? Math.round(periods.reduce((a, r) => a + Number(r.counted || 0), 0) * 100) / 100 : null,
      counted_periods: periods.length,
      counted_clipped: periods.filter((r) => r.clipped).length,
      tips: tips?.tips ?? null, fare: tips?.fare ?? null,
      statement_cash: tips?.cash ?? null,
      statement_gross: tips?.gross ?? null,
      statement_fees: tips?.fees ?? null,
      statement_salik: tips?.salik ?? null,
      statement_days: tips?.statement_days ?? 0,
      tip_pct: tips?.fare > 0 ? +((tips.tips / tips.fare) * 100).toFixed(2) : null });
  }));

  /* ── quality: cancellations, safety events, unauthorised use ───────── */
  app.get('/api/driver/quality', withDriver(async (req, res, d, p) => {
    const cancels = await q(
      // The raw provider string, kept deliberately — the point of this table
      // is to show the vocabulary each platform actually uses. But what counts
      // as "not completed" is decided by the normalised outcome, so Bolt's
      // 'finished' is not listed here as a failure reason, which is what
      // status <> 'completed' did.
      `SELECT coalesce(status,'unknown') status, platform, count(*)::int n,
              round(100.0*count(*)/sum(count(*)) OVER (),1) pct
       FROM trip_norm WHERE ${TW} AND outcome = 'not_completed'
       GROUP BY 1,2 ORDER BY n DESC LIMIT 12`, p);
    const cancelDaily = await q(
      `SELECT local_day AS day,
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int trips
       FROM trip_norm WHERE ${TW} GROUP BY 1 ORDER BY 1`, p);
    // Harsh-driving events are recorded against the vehicle, so they are only
    // this driver's when they held the vehicle that day.
    // DISTINCT matters: vehicle_driver_day carries one row per platform, so a
    // driver who ran Uber and Yango on the same plate the same day would have
    // every harsh-driving event on that day counted twice.
    const alerts = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       /* Marked for what it is, so the tile above this table does not have to
          classify it again — the Quality tile sums these rows and the tracker
          losing its own power is not a thing this person did. The word list
          lives in api/alert_coverage_sql.js and nowhere else. */
       SELECT a.alert_type, count(*)::int n, max(a.occurred_at) latest,
              bool_or(${DEVICE_FAULT_SQL('a.alert_type')}) AS device
       FROM alert a JOIN days ON days.plate = a.plate
            AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       GROUP BY 1 ORDER BY n DESC LIMIT 15`, p);
    /* Whether the telematics feed saw this person's cars at all.
       ─────────────────────────────────────────────────────────────────────
       The third reason this rate can be absent, and the one that used to fall
       straight through to the divide. A driver whose cars are on no telematics
       feed drove the distance in the denominator and produced no alert row, so
       the tile read a confident 0.0 per 100 km — measured on the drivers
       ledger for the same people, 26 of 309 rows at days=30, against a fleet
       rate of 86.4. alerts 0 with device_alerts 0 cannot tell that apart from
       a genuinely clean record; the journey count can. Same custody days as
       the alert query above, so the numerator and this are about one set of
       plate-days; plate_days is carried so that "no custody row at all" stays
       a different absence from "the feed saw nothing". */
    const [tele] = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT (SELECT count(*)::int FROM days) AS plate_days,
              count(*)::int AS telematics_journeys
       FROM trip t JOIN days ON days.plate = t.plate
            AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       WHERE t.platform = 'fms'
         AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`, p);
    const trackedJourneys = tele && tele.plate_days ? tele.telematics_journeys : null;
    /* The days the alert feed covered, and both halves of the rate narrowed to
       them.
       ─────────────────────────────────────────────────────────────────────
       The exposure below used to run to the edge of the window. Measured on
       production 2026-09-02 the fleet figure this page paints a driver against
       read 69.7 per 100 km over 16 days and 41.5 over 30 — the identical
       69,338 alerts over 68% more distance — because the alert feed had a
       73-day hole (2026-06-06 to 2026-08-17) and days 17 to 30 back from today
       sat inside it. So a driver widening their own window watched themselves
       improve, and the baseline they were painted against moved further.

       Dubai calendar days: winDays, not the timestamp bounds in p, because a
       covered day is a calendar day everywhere else in this product. */
    const [covFrom, covTo] = winDays(req);
    const cov = await alertCoverage(q, covFrom, covTo);
    const [exposure] = await q(
      `SELECT round(sum(km)::numeric,0) km FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
         AND day = ANY($4::date[])`, [...p, cov.days]);
    /* What the fleet does, so 29.5 per 100 km has something to be high
       AGAINST. The page painted this figure critical from a hardcoded 5/15
       scale under a sub-label reading "comparable across drivers" — comparable
       to nothing, because the comparison was a constant somebody chose. */
    const [fleetRate] = await q(
      `WITH k AS (
         SELECT sum(km) km FROM vehicle_driver_day
          WHERE day BETWEEN $1::date AND $2::date AND day = ANY($3::date[])),
       a AS (
         SELECT ${drivingCount()} n, ${deviceCount()} device FROM alert
          WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
            AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($3::date[]))
       SELECT round(k.km::numeric, 0) AS km, a.n AS alerts, a.device AS device_alerts
         FROM k, a`, [p[0], p[1], cov.days]);
    /* Split, not summed. Main Power Lost is the tracker reporting its own
       power loss, and this rate is the one the page paints a person against —
       so a driver whose car has a failing box was ranked as a hard driver.
       The rows are already grouped by type here, so the shared classifier
       applies directly rather than through a second query. */
    const totalAlerts = alerts.filter((r) => !isDeviceFault(r.alert_type))
      .reduce((a, r) => a + r.n, 0);
    const deviceAlerts = alerts.filter((r) => isDeviceFault(r.alert_type))
      .reduce((a, r) => a + r.n, 0);
    res.json({ cancels, cancel_daily: cancelDaily, alerts,
      /* The distance the rate was taken over: this person's custody kilometres
         on the days the alert feed was up, and no others. */
      alert_km: exposure?.km ?? null,
      /* Both figures through the same rule, so the driver and the baseline
         they are painted against are measured over the identical days. Null
         rather than 0 when the feed covered nothing in the window — a page
         must render that as "not measured", not as a spotless record. */
      alerts_per_100km: alertRate(totalAlerts, exposure?.km, cov, 1,
        { device: deviceAlerts, tracked: trackedJourneys }),
      alerts_per_100km_absent: alertRateReason(exposure?.km, cov,
        { alerts: totalAlerts, device: deviceAlerts, tracked: trackedJourneys }),
      device_alerts: deviceAlerts,
      /* Beside the rate, because it is why the rate is absent when it is: 0 is
         a car the feed never saw, null is a person no custody row places in a
         car at all. The same field the asset and people ledgers carry. */
      telematics_journeys: trackedJourneys,
      fleet_alerts_per_100km: alertRate(fleetRate?.alerts, fleetRate?.km, cov, 1,
        { device: fleetRate?.device_alerts }),
      fleet_device_alerts: fleetRate?.device_alerts ?? null,
      fleet_alert_km: fleetRate?.km == null ? null : Number(fleetRate.km),
      fleet_alerts: fleetRate?.alerts ?? null,
      /* Which days both figures are about, in words the page prints. */
      alert_coverage: cov });
  }));

  /* ── the raw record, because eventually someone needs the trips ────── */
  /* ── the trip ledger, paged, and honest about being paged ─────────────
     This returned a bare array capped at whatever `limit` asked for, and said
     nothing about how many trips the window actually holds. The page then
     printed "the server sent the 500 newest trips in this window, so older
     ones are not on this page at all" — true, and unusable: 500 of how many?
     Of six hundred, that sentence is a footnote. Of twelve hundred, the reader
     is looking at two fifths of the evidence and has no way to reach the rest.

     So the count comes back with the rows, and so does an offset, which is
     what turns a dead end into a page. The count is a second query rather than
     a window function over the same one — a COUNT(*) OVER () is evaluated for
     every row returned, and on a 1,000-row page that is a thousand copies of
     the same integer travelling over the wire. */
  app.get('/api/driver/trips', withDriver(async (req, res, d, p) => {
    const limit = Math.min(+req.query.limit || 200, 1000);
    const offset = Math.max(0, +req.query.offset || 0);
    const [rows, [t], days] = await Promise.all([
      q(`SELECT platform, external_id, requested_at, ended_at, plate, pickup_addr, dropoff_addr,
                distance_km, duration_s, status, product, payment_type, price, currency,
                -- The Dubai calendar day this trip belongs to, as a string.
                -- A bare DATE reaches node-postgres as a JS Date, and slicing
                -- ten characters off its default string form yields "Sat Aug
                -- 01" rather than a date — the trap driver_day_keys and
                -- server_day_keys both grep this file for. The key the client
                -- joins the day list on is formed here, once, in SQL.
                to_char(local_day, 'YYYY-MM-DD') AS local_day,
                -- The provider's own word stays in the status column; outcome is
                -- what the UI may colour by, because the four platforms disagree
                -- about which strings mean success.
                outcome, is_booking, has_fare
         FROM trip_norm WHERE ${TW}
         ORDER BY requested_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      q(`SELECT count(*)::int n FROM trip_norm WHERE ${TW}`, p),
      /* What a trip with no fare of its own is nevertheless part of.
         ─────────────────────────────────────────────────────────────────
         Uber's trip export carries no fare column, so four fifths of this
         table's Fare cells were an em-dash under a caption explaining that
         nothing prices these rides. That caption is true and it is not the
         best answer available: Uber DOES publish the money, per driver per
         day, and driver_payout_day holds it. A reader looking at a 2
         September Uber ride can be told the driver earned AED 73.78 across
         four Uber trips that day.

         Per (platform, day), never per trip. Dividing the day by its trip
         count would invent a per-trip fare Uber has never stated, and the
         trips of a day are not equal — see sql/schema_v58.sql for what
         happens when a coarser figure is allowed to stand in for a finer one.
         The day is the finest grain that exists, so the day is what is shown.

         Summed across the driver's keys and any fleet: one person may hold an
         account in both fleets, and driver_payout_day is keyed per fleet. */
      q(`WITH t AS (
           SELECT platform, (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                  count(*)::int                              AS trips,
                  count(*) FILTER (WHERE has_fare)::int      AS priced
             FROM trip_norm WHERE ${TW}
            GROUP BY 1, 2)
         SELECT t.platform, to_char(t.day, 'YYYY-MM-DD') AS day, t.trips, t.priced,
                pd.earnings, pd.cash_earnings, pd.grain_reason
           FROM t
           LEFT JOIN LATERAL (
             SELECT sum(pdd.earnings)      AS earnings,
                    sum(pdd.cash_earnings) AS cash_earnings,
                    /* Present only when the day carries no money BECAUSE a
                       finer report already stated it — the sentence the
                       server wrote on the row, printed rather than inferred
                       from a NULL. */
                    max(pdd.grain_reason)  AS grain_reason
               FROM driver_payout_day pdd
              WHERE pdd.driver_ext_id = ANY($3)
                AND pdd.platform = t.platform
                AND pdd.day = t.day) pd ON true`, p),
    ]);
    const total = t?.n ?? rows.length;
    res.json({ rows, total, shown: rows.length, offset, limit,
      /* Keyed `platform|day`, matching each row's own platform and local_day.
         A list rather than an object so the shape survives JSON with no key
         ordering assumptions, and so a day with no money still appears with
         its trip count instead of vanishing. */
      days,
      /* Stated as a flag as well as derivable, so a renderer cannot get the
         comparison the wrong way round and claim a complete list. */
      truncated: offset + rows.length < total });
  }));

  /* ── which vehicles, day by day (handovers visible) ────────────────── */
  app.get('/api/driver/custody', withDriver(async (req, res, d, p) => {
    const rows = await q(
      `SELECT day, plate, platform, trips, km, revenue, first_trip_at, last_trip_at, is_primary
       FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       ORDER BY day DESC, trips DESC LIMIT 400`, p);
    // 60 of 256 rows reached the Activity tab with nothing saying so.
    const [t] = await q(
      `SELECT count(*)::int n FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    res.json({ rows, total: t?.n ?? rows.length, shown: rows.length,
      truncated: (t?.n ?? 0) > rows.length });
  }));

  /* The mirror of the vehicle page's custody table: which cars has this person
     had. Moved here from server.js, where three things were wrong with it:

       - it took `driver_id` while every one of its eleven siblings takes `id`,
         so a link built the way the rest of the app builds links answered 400
       - it took ONE raw id, so somebody with an Uber account and a Bolt account
         saw the cars from one of them
       - it ignored the window, so it answered about all of history on a page
         filtered to a month

     withDriver resolves the person, hands over their whole key set, applies the
     window and refuses an id nobody has. `driver_id` is still accepted, because
     an address somebody has already bookmarked should not start 404ing. */
  app.get('/api/driver/vehicles', (req, res, next) => {
    if (!req.query.id && req.query.driver_id) req.query.id = req.query.driver_id;
    return next();
  }, withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT plate, count(DISTINCT day)::int days, sum(trips)::int trips,
            round(sum(km)::numeric,0) km, round(sum(revenue)::numeric,0) revenue,
            min(day) first_day, max(day) last_day,
            count(DISTINCT day) FILTER (WHERE is_primary)::int primary_days,
            array_agg(DISTINCT platform) AS platforms
     FROM vehicle_driver_day
     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
     GROUP BY plate ORDER BY days DESC, trips DESC`, p))));
}
