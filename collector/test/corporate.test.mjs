/* An authorisation that exists is not an authorisation that was granted.
   ─────────────────────────────────────────────────────────────────────────
   trip_ext.has_authorization meant `raw -> 'authorization' IS NOT NULL` from
   sql/schema_v18.sql:182-183 until sql/schema_v62.sql, and every reader of it
   asked it a different question. The hotel provider attaches the authorisation
   object when a booking is RAISED, not when anybody approves it, so the column
   answered "did somebody start the workflow" while #corporate asked "was this
   booking approved" — on the one page whose entire subject is billing control.

   What that cost, measured on production on 2026-09-05 over 2026-01-01 →
   2026-09-05, before any of this shipped:

     /api/corporate/summary        1,737 bookings, authorized_trips 225,
                                   authorized_pct 13
     /api/corporate/properties     "Office" (675d566697467adfe29a32c7) has
                                   exactly 225 bookings, all priced, AED 39,198,
                                   average fare AED 174.21 — and it is the only
                                   one of the six whose approval_required is true
     /api/corporate/leakage        unauthorized n 0, disabled null,
                                   properties_requiring_approval 1 of 6

   So the leakage strip printed a hard zero beside "Charged with no
   authorisation on file", styled as a category that had looked and found
   nothing, while every billed booking at the only property that requires an
   approval had been charged without one — 212 of that property's 225 bookings
   are billed, the other 13 being priced at zero, and not one of the 225 had
   been granted. The Overview KPI was wrong in the
   opposite direction at the same time: 13% under a caption reading "of bookings
   at properties that require one", which is 225 over all 1,737 channel bookings
   rather than over the 225 the caption names — and under the old definition the
   caption's own claim would have read 100%.

   The key names in the fixture below are the provider's own, enumerated rather
   than guessed. /api/probe/results lists exactly four members under
   `authorization` on the hotel trip-report surface — _id, authorizationRequired,
   authorizationStatus and authorizationBy — with authorizationStatus carrying a
   single distinct value across every row that has one and authorizationBy
   filled on 0% of them, and four under `operatorApproval` — _id, status,
   approvedAt, approvedBy — whose status really does take more than one value:
   /api/schema/raw-values returns two objects, both "approved" by
   69cb9d14b11d90e2dcc28690 on 2026-09-04, and the probe has seen a "rejected".
   A predicate reading only the first key would report zero approvals across the
   whole record, which is the same bug wearing the opposite sign.

   Every assertion below is pinned on a PROPERTY of the answer rather than on a
   spelling or a production figure: that a raised-and-unanswered approval is not
   an approval, that an approved one is, whichever of the two keys carries it,
   and that the rate the Overview prints is measured over the bookings its own
   caption names. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { analyticsRoutes } from '../api/analytics_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, distance_km, duration_s, status, product, payment_type,
                     price, partner_id, partner_name, raw)
   VALUES ('hotel', $1, 'ecosine', 'L100', 'hd1', 'Driver One', $2, 10, 900, 'completed',
           'drop_off', 'room-charge', $3, $4, $5, $6)`,
  [o.id, `2026-08-${String(o.day).padStart(2, '0')}T10:00:00+04:00`,
   o.price ?? 100, o.partner, o.partner === 'p-req' ? 'Requires Approval Hotel' : 'Open House',
   JSON.stringify({ client: `guest-${o.id}`, ...(o.raw || {}) })]);

/* Two properties. Only one runs an approval workflow, which is the qualifier
   the leakage category has carried since it otherwise fired on 87% of every
   booking on the channel. */
await q(`INSERT INTO partner (platform, partner_id, name, approval_required, active)
         VALUES ('hotel', 'p-req',  'Requires Approval Hotel', true,  true),
                ('hotel', 'p-open', 'Open House',              false, true)`);

/* Eight billed bookings at the property that requires an approval, covering
   every state the provider's two keys can be in. Three of them are granted and
   five are not, and exactly one of the five has nothing on file at all. */
await trip({ id: 'pend1',  day: 10, partner: 'p-req',
  raw: { authorization: { _id: 'a1', authorizationRequired: true, authorizationStatus: 'pending', authorizationBy: null } } });
await trip({ id: 'pend2',  day: 10, partner: 'p-req',
  raw: { authorization: { _id: 'a2', authorizationRequired: true, authorizationStatus: 'pending', authorizationBy: null } } });
// A bare stub with no status at all — the shape the old column called "yes".
await trip({ id: 'stub',   day: 10, partner: 'p-req', raw: { authorization: { _id: 'a3' } } });
await trip({ id: 'appr1',  day: 10, partner: 'p-req',
  raw: { authorization: { _id: 'a4', authorizationStatus: 'approved', authorizationBy: { _id: 'u1' } } } });
// The second key, and the only one in the live record that has ever said yes.
await trip({ id: 'appr2',  day: 10, partner: 'p-req',
  raw: { operatorApproval: { _id: 'o1', status: 'approved', approvedBy: 'u1', approvedAt: '2026-08-10T11:00:00Z' } } });
// Whatever case the provider sends it in, an approval is an approval.
await trip({ id: 'apprUC', day: 10, partner: 'p-req',
  raw: { authorization: { _id: 'a5', authorizationStatus: 'Approved', authorizationBy: { _id: 'u1' } } } });
// Decided and refused. Not granted, and not pending either.
await trip({ id: 'rej1',   day: 10, partner: 'p-req',
  raw: { operatorApproval: { _id: 'o2', status: 'rejected' } } });
// Nothing on file at all: the row a NULL-returning predicate silently drops.
await trip({ id: 'none1',  day: 10, partner: 'p-req', raw: {} });

/* And one booking at the property that does NOT run an approval workflow,
   raised and unanswered, which must never be accused of anything. It sits on
   its own day so that a window holding it and nothing else exercises the
   denominator that does not exist. */
await trip({ id: 'open1',  day: 20, partner: 'p-open',
  raw: { authorization: { _id: 'b1', authorizationStatus: 'pending' } } });

/* ── mount the real module ───────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const asDate = (v, f) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : f);
const range = (req) => [asDate(req.query.from, '2000-01-01'), asDate(req.query.to, '2100-01-01'),
  req.query.platform || null, req.query.fleet || null];
const F = `local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;
analyticsRoutes(app, { q, wrap, range, F, FB: `${F} AND is_booking` });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const W = 'from=2026-08-01&to=2026-08-15';   // the eight p-req bookings
const OPEN = 'from=2026-08-18&to=2026-08-25'; // only the p-open one

/* ── raised is not granted ───────────────────────────────────────────────── */
{
  const accused = await get(`/api/corporate/leakage?${W}&kind=unauthorized`);
  const byId = Object.fromEntries(accused.rows.map((r) => [r.external_id, r]));
  check('a booking whose authorisation was raised and never answered is not authorised',
    ['pend1', 'pend2', 'stub'].every((id) => byId[id] && byId[id].has_authorization === false),
    JSON.stringify(accused.rows.map((r) => [r.external_id, r.has_authorization])));
  check('and it is told apart from a booking with no authorisation on file at all',
    ['pend1', 'pend2', 'stub'].every((id) => byId[id]?.authorization_pending === true)
    && byId.none1 && byId.none1.authorization_pending === false,
    JSON.stringify(accused.rows.map((r) => [r.external_id, r.authorization_pending])));
  /* NOT has_authorization over a predicate that can be NULL drops the row
     instead of accusing it — the same category pinned at zero for a third
     reason. A booking with no authorisation is the whole point of the
     category and must be in it. */
  check('a booking with nothing on file is still accused rather than dropped',
    Boolean(byId.none1), accused.rows.map((r) => r.external_id).join(','));
  /* A rejected approval printed as "pending" is a false reason, and a reader
     acts on the reason. The provider's own word travels with the row. */
  check('a refused approval is reported in the provider’s own word, not as pending',
    byId.rej1?.authorization_status === 'rejected', JSON.stringify(byId.rej1?.authorization_status));
}

/* ── granted is granted, under either of the two keys ────────────────────── */
{
  const accused = await get(`/api/corporate/leakage?${W}&kind=unauthorized`);
  const ids = accused.rows.map((r) => r.external_id);
  check('an approved authorisation is an authorisation',
    !ids.includes('appr1') && !ids.includes('apprUC'), ids.join(','));
  check('…including the one the provider publishes under operatorApproval',
    !ids.includes('appr2'), ids.join(','));
  const s = await get(`/api/corporate/summary?${W}`);
  check('and the summary counts exactly the granted ones',
    s.authorized_trips === 3, `${s.authorized_trips}`);
  check('with the raised-and-unanswered ones counted apart, never as authorised',
    s.authorization_pending_trips === 4, `${s.authorization_pending_trips}`);
}

/* ── the rate is measured over the bookings its own caption names ────────── */
{
  /* Measured over the WHOLE month, not over the window that holds only the
     approval-requiring property's bookings. In that narrower window every
     booking is at p-req, so the caption's denominator and the channel's are the
     same number and an assertion pinned there passes under either definition
     and proves nothing. August holds the p-open booking as well, so the two
     denominators are 8 and 9 and only one of them matches the caption. */
  const s = await get('/api/corporate/summary?from=2026-08-01&to=2026-08-31');
  const props = await get('/api/corporate/properties?from=2026-08-01&to=2026-08-31');
  const requiring = props.filter((p) => p.partner_id === 'p-req')
    .reduce((a, p) => a + p.bookings, 0);
  check('the two denominators are genuinely different in this window',
    requiring > 0 && requiring < s.bookings, `${requiring} of ${s.bookings}`);
  check('the authorisation rate’s denominator is the bookings at properties that require one',
    s.approval_required_bookings === requiring, `${s.approval_required_bookings} vs ${requiring}`);
  check('…and the rate is that denominator’s own share, not the channel’s',
    s.authorized_pct === Math.round((s.authorized_trips / requiring) * 1000) / 10
    && s.authorized_pct !== Math.round((s.authorized_trips / s.bookings) * 1000) / 10,
    `${s.authorized_pct} for ${s.authorized_trips}/${requiring}, channel would be `
    + `${Math.round((s.authorized_trips / s.bookings) * 1000) / 10}`);
}

/* ── a denominator that does not exist is absent with a reason ───────────── */
{
  const s = await get(`/api/corporate/summary?${OPEN}`);
  check('a window with no booking at an approval-requiring property reports no rate',
    s.authorized_pct === null && s.approval_required_bookings === 0,
    `${s.authorized_pct} over ${s.approval_required_bookings}`);
  check('…and says why, rather than printing a rate of zero',
    /no booking in this window/i.test(s.authorized_absent_reason || ''),
    String(s.authorized_absent_reason));
  check('the reason never claims the properties failed to declare when one has',
    !/has declared whether/i.test(s.authorized_absent_reason || ''),
    String(s.authorized_absent_reason));
}

/* ── the category stops reading as a clean bill of health ────────────────── */
{
  const l = await get(`/api/corporate/leakage?${W}`);
  const k = l.kinds.find((x) => x.kind === 'unauthorized');
  check('every billed booking at the requiring property that was never granted is counted',
    k.n === 5, String(k.n));
  check('its label no longer claims the authorisation object is missing',
    !/on file/i.test(k.label) && !/no authorisation object/i.test(k.why),
    `${k.label} — ${k.why}`);
}

server.close();

/* ── the page reads what the endpoint returns ────────────────────────────
   A green suite is not a rendered page: #supply once printed "noFeed is not
   defined" while thirty assertions passed. Two static checks on the module
   itself, neither of which needs a browser — every local it reads is declared
   in it, and every field of the summary payload it names is a field the
   summary really returns. */
{
  const src = readFileSync(new URL('../api/public/corporate.js', import.meta.url), 'utf8');
  const declared = new Set([...src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1])
    .concat([...src.matchAll(/\bimport\s*\{([^}]*)\}/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())))
    .concat([...src.matchAll(/\(([^)]*)\)\s*=>/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/[={].*$/, '').trim())))
    /* Declared parameters of a plain `function` too, and not only of arrows —
       renderProperty(root, id, tab, onDetail) is a real declaration and the
       arrow-only harvest in test/supply_chip_denominator.test.mjs calls its
       last parameter undeclared. A guard that cries wolf on correct code is a
       guard somebody deletes. */
    .concat([...src.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/[={].*$/, '').trim())))
    .filter(Boolean));
  const read = [...src.matchAll(/(?<![.\w'"`-])([a-z][a-zA-Z0-9]*[A-Z][\w$]*)\s*\?/g)].map((m) => m[1]);
  const missing = [...new Set(read)].filter((n) => !declared.has(n));
  check('every local the corporate page reads is declared in it', missing.length === 0, missing.join(', '));

  const NEEDED = ['authorized_pct', 'authorized_trips', 'approval_required_bookings',
    'authorization_pending_trips', 'authorized_absent_reason'];
  const namedOnPage = NEEDED.filter((f) => new RegExp(`\\bs\\.${f}\\b`).test(src));
  check('the page names the authorisation fields it prints', namedOnPage.length === NEEDED.length,
    NEEDED.filter((f) => !namedOnPage.includes(f)).join(', '));
}
{
  const app2 = express();
  analyticsRoutes(app2, { q, wrap, range, F, FB: `${F} AND is_booking` });
  const srv = app2.listen(0);
  const p2 = srv.address().port;
  const s = await (await fetch(`http://127.0.0.1:${p2}/api/corporate/summary?${W}`)).json();
  srv.close();
  const src = readFileSync(new URL('../api/public/corporate.js', import.meta.url), 'utf8');
  const namedFields = [...new Set([...src.matchAll(/\bs\.([a-z][a-z0-9_]*)\b/g)].map((m) => m[1]))];
  const absent = namedFields.filter((f) => !(f in s));
  check('and every summary field it names is one the endpoint returns', absent.length === 0,
    absent.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
