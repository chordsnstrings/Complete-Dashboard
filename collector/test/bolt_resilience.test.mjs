/* ── everything the adversarial review found in my own Bolt rewrite ────────
   I shipped the portal harvest, queued the backfill it was written for, and it
   wrote 70 rows over two years. I fixed that, shipped again, and a review of
   the fix found twenty-three more. These are the ones about the harvest not
   losing what it has already collected, and about the run telling the truth
   afterwards.

   Every one of them is a way for this source to go quiet without anything
   saying so, which is the failure this file has had since it was written. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import { harvestPortal, portalRow } from '../src/sources/bolt.js';
import { reconcilePlate } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nbolt: a harvest that does not lose what it collected');

const C = { fleet: 'egari', companyId: 142897, userId: 174036 };
const ROW = (o) => portalRow(o, C);
const nap = async () => {};
const day = (d) => new Date(`${d}T00:00:00Z`);
const orderOn = (iso, n) => ({ driver: { id: String(1000 + n), name: `D${n}` },
  created: Math.floor(day(iso).getTime() / 1000) + n, car_reg_number: 'L00001',
  route: ['a', 'b'], status: 'finished', distance: 3, price: 20, category: 'Bolt',
  arrived_to_destinations: [], payment_method: 'in_app' });
const asColumns = (orders, total) => ({ code: 0, message: 'OK', data: {
  total_rows: total ?? orders.length,
  columns: Object.keys(orders[0] || { created: 0 }).map((k) => ({ key: k,
    cells: orders.map((o) => o[k]) })) } });
const portal = ({ perDay = 1, since = '2020-01-01' } = {}) => async (win, offset) => {
  if (win.start < day(since)) return { code: 25809, message: 'START_DATE_TOO_FAR_IN_THE_PAST' };
  const orders = [];
  for (let t = win.start.getTime(); t <= win.end.getTime(); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10);
    for (let k = 0; k < perDay; k++) orders.push(orderOn(d, orders.length));
  }
  return asColumns(orders.slice(offset, offset + 100), orders.length);
};

/* ── a throw is a window that did not answer, not a run that failed ──────── */
let calls = 0;
const throwsOnCall = (n, inner) => async (win, offset) => {
  if (++calls === n) throw new Error('fetch failed (ECONNRESET)');
  return inner(win, offset);
};
calls = 0;
const survived = await harvestPortal({ from: '2026-06-01', to: '2026-08-30',
  ask: throwsOnCall(2, portal()), row: ROW, sleep: nap });
check('a thrown request does not unwind the whole harvest',
  survived.rows.length > 0, `${survived.rows.length} rows`);
check('and the window that threw is recorded as a refusal',
  survived.refusals.length === 1 && /ECONNRESET/.test(survived.refusals[0].says),
  JSON.stringify(survived.refusals));
check('and the windows after it are still asked',
  survived.chunks.filter((c) => !c.error).length >= 1,
  JSON.stringify(survived.chunks.map((c) => c.error ? 'x' : 'ok')));

/* ── success is explicit, not the absence of a failure ───────────────────── */
const HTML = '<html><head><title>502 Bad Gateway</title></head></html>';
const garbage = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: async () => HTML, row: ROW, sleep: nap });
check('an HTML error page is a refusal, not an empty window',
  garbage.refusals.length === 1 && garbage.rows.length === 0,
  JSON.stringify(garbage.refusals));
check('and the refusal says what arrived instead',
  /unrecognisable response/.test(garbage.refusals[0].says), garbage.refusals[0].says);
/* The specific shape that used to pass: a JSON object with no numeric code. */
const noCode = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: async () => ({ message: 'Forbidden' }), row: ROW, sleep: nap });
check('a JSON body with no code is a refusal too',
  noCode.refusals.length === 1 && noCode.rows.length === 0, JSON.stringify(noCode.refusals));
/* And OK-with-no-columns, which is the same silence by a third route. */
const noCols = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: async () => ({ code: 0, message: 'OK', data: { total_rows: 40 } }), row: ROW, sleep: nap });
check('OK with no columns is a refusal, not forty rows silently lost',
  noCols.refusals.length === 1, JSON.stringify(noCols.refusals));

/* ── rows that arrive and cannot be keyed are counted, never silent ─────── */
const renamed = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  /* Every field intact except the one the key is built from. */
  ask: async (win, offset) => {
    const r = await portal()(win, offset);
    if (!r.data?.columns) return r;
    return { ...r, data: { ...r.data,
      columns: r.data.columns.map((c) => (c.key === 'driver' ? { ...c, key: 'driver_v2' } : c)) } };
  }, row: ROW, sleep: nap });
check('a renamed column is reported, not read as an empty window',
  renamed.dropped === 30 && renamed.rows.length === 0,
  `dropped ${renamed.dropped}, rows ${renamed.rows.length}`);

/* ── a window short of the count the portal declared says so ─────────────── */
const short = await harvestPortal({ from: '2026-08-01', to: '2026-08-10',
  /* Declares more than it serves — which is what an offset-paged tie on
     `created` looks like from this side, and there is no cursor to ask for
     instead. It cannot be prevented here; it can be SEEN. */
  ask: async (win, offset) => {
    const r = await portal()(win, offset);
    if (!r.data?.columns) return r;
    return { ...r, data: { ...r.data, total_rows: r.data.total_rows + 3 } };
  }, row: ROW, sleep: nap });
check('a shortfall against the declared total is detected',
  short.short === 3, `short ${short.short}`);
check('and the window carries the reason, not just a row count',
  short.chunks.some((c) => /declared/.test(c.error || '')),
  JSON.stringify(short.chunks));

/* ── every window is reported, in the shape logRun stores ────────────────── */
const walked = await harvestPortal({ from: '2026-06-01', to: '2026-08-30',
  ask: portal(), row: ROW, sleep: nap });
check('one chunk per window attempted', walked.chunks.length === walked.windows,
  `${walked.chunks.length} of ${walked.windows}`);
check('each carries from, to, rows and error',
  walked.chunks.every((c) => c.from && c.to && typeof c.rows === 'number' && 'error' in c),
  JSON.stringify(walked.chunks[0]));
check('and the rows add up to the harvest',
  walked.chunks.reduce((a, c) => a + c.rows, 0) === walked.rows.length);

/* ── rows are handed over per window, so a late throw costs one window ──── */
const written = [];
calls = 0;
const sunk = await harvestPortal({ from: '2026-06-01', to: '2026-08-30',
  ask: throwsOnCall(3, portal()), row: ROW, sleep: nap,
  sink: async (batch) => { written.push(...batch); } });
check('the sink receives rows as they are collected',
  written.length > 0, `${written.length} written`);
check('and the rows already handed over are not returned again',
  sunk.rows.length === 0, `${sunk.rows.length} left in the return`);
check('so nothing is written twice',
  new Set(written.map((r) => r.external_id)).size === written.length);

/* ── the plate that arrived without its letter code ──────────────────────── */
const known = new Set(['L36397', 'L64009', 'L46184']);
check('a digits-only plate is reconciled when exactly one car matches',
  reconcilePlate('36397', known) === 'L36397');
check('an ambiguous one is left alone',
  reconcilePlate('36397', new Set(['L36397', 'M36397'])) === '36397');
check('a plate that already has its letter is untouched',
  reconcilePlate('L36397', known) === 'L36397');
check('and with no list to check against, it arrives as filed',
  reconcilePlate('36397', null) === '36397');
check('portalRow reconciles through it',
  portalRow({ driver: { id: '1' }, created: 1788417701, car_reg_number: '36397' }, C, known).plate === 'L36397');

/* ── and the migration repairs what is already stored ────────────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
await q(`INSERT INTO vehicle (plate) VALUES ('L36397'),('L64009')`).catch(async () => {
  await q(`INSERT INTO vehicle (plate, fleet_id) VALUES ('L36397','ecosine'),('L64009','ecosine')`);
});
let n = 0;
const trip = (platform, plate) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
   VALUES ($1,$2,'ecosine',$3,'2026-08-20T09:00:00Z','finished')`, [platform, `t${++n}`, plate]);
await trip('uber', 'L36397');
await trip('bolt', '36397');
await trip('bolt', '36397');
await trip('bolt', '64009');
/* No lettered counterpart anywhere: must stay as it is rather than be guessed. */
await trip('bolt', '99999');
await db.exec(readFileSync('sql/schema_v56.sql', 'utf8'));
const after = await q(`SELECT plate, count(*)::int n FROM trip WHERE platform='bolt' GROUP BY 1 ORDER BY 1`);
const m = Object.fromEntries(after.map((r) => [r.plate, r.n]));
check('the migration moves the reconcilable rows onto the real car',
  m.L36397 === 2 && m.L64009 === 1, JSON.stringify(m));
check('and leaves a plate with no counterpart exactly where it is',
  m['99999'] === 1, JSON.stringify(m));
check('the other channel’s row is untouched',
  (await q(`SELECT count(*)::int n FROM trip WHERE platform='uber' AND plate='L36397'`))[0].n === 1);
/* Idempotent: it runs on every boot until its hash is recorded. */
await db.exec(readFileSync('sql/schema_v56.sql', 'utf8'));
const again = await q(`SELECT plate, count(*)::int n FROM trip WHERE platform='bolt' GROUP BY 1 ORDER BY 1`);
check('replaying it changes nothing',
  JSON.stringify(Object.fromEntries(again.map((r) => [r.plate, r.n]))) === JSON.stringify(m));

/* ── the end date may not be in the future ───────────────────────────────
   Found by running the real harvest against the live portal, which no fixture
   would have caught: end_date 2026-09-03 answered with 79 orders and
   2026-09-04 answered INVALID_REQUEST (code 702). A window ending tomorrow
   therefore loses TODAY — the most valuable window there is. */
const asked = [];
const recorder = async (win, offset) => { asked.push([win.start, win.end]); return portal()(win, offset); };
const tomorrow = new Date(Date.now() + 4 * 3600e3 + 864e5).toISOString().slice(0, 10);
const todayD = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const clamped = await harvestPortal({ from: '2026-08-01', to: tomorrow,
  ask: recorder, row: ROW, sleep: nap });
check('a window ending in the future is clamped to today, not refused',
  asked.every(([, e]) => e.toISOString().slice(0, 10) <= todayD),
  asked.map(([, e]) => e.toISOString().slice(0, 10)).join(' '));
check('and the caller is told its end date moved',
  clamped.clamped && clamped.clamped.served_to === todayD, JSON.stringify(clamped.clamped));
check('a window that already ends today is not clamped',
  (await harvestPortal({ from: '2026-08-01', to: todayD, ask: portal(), row: ROW, sleep: nap })).clamped === null);

/* Windows ATTEMPTED, not generated: the walk stops at the retention boundary,
   and a coverage figure that counts windows it never asked for overstates
   itself — which is the whole subject of this file. */
const stopped = await harvestPortal({ from: '2024-01-01', to: '2026-08-30',
  ask: portal({ since: '2026-06-01' }), row: ROW, sleep: nap });
check('windows counts what was asked, not what was generated',
  stopped.windows < stopped.generated && stopped.windows === stopped.chunks.length,
  `attempted ${stopped.windows}, generated ${stopped.generated}, chunks ${stopped.chunks.length}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
