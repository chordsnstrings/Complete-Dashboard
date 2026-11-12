/* EVERY FILE A SIGNED-IN PERSON TAKES AWAY SAYS WHO TOOK IT AND WHEN.
   ═════════════════════════════════════════════════════════════════════════
   ULM-DESIGN §9.3 ("Exports are … stamped with user and time, and
   audited"), §13 phase 4. api/access/watermark.js stamps; each route that
   hands back a file calls it. This file proves the stamp itself, then asks
   EVERY such route — the trip CSV, the money workbook, Today, the month
   target, the low performers, a watch list, the assistant's attached
   workbook — once as a signed-in person and once as a visitor, through
   test/mount.mjs with the caller set the way the access gate sets it
   (req.fm). The visitor's file must be exactly what it always was.

   REVERSIONS, each run on 2026-11-12 and each failing as named:
     export_routes.js: drop the csvStampLine write → "the trip CSV opens
       with who exported it" fails.
     money_export_routes.js: drop the stampWorkbook call → "the money
       workbook is stamped" fails.
     lowperf_routes.js sendBook: drop the stampWorkbook call → both low-
       performer files fail.
     xlsx_write.js Sheet.xml: drop the headerFooter → "every sheet's print
       footer" fails.
     watermark.js exportStamp: return a stamp for an anonymous caller →
       "a visitor gets no stamp" fails. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { exportStamp, csvStampLine, stampWorkbook } from '../api/access/watermark.js';
import { Workbook } from '../src/xlsx_write.js';
import { unzip } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PERSON = { kind: 'user', user: { id: 21, email: 'ops@example.test', name: 'Test Ops' },
  access: { caps: ['export'], preview: null },
  levels: Object.fromEntries(['ID', 'CT', 'DOC', 'EARN', 'CASH', 'COND', 'REV', 'PAY', 'BK', 'LOC', 'VEH', 'PAX', 'SYS'].map((c) => [c, 'F'])) };
/* A visitor while sign-in is optional, exactly as identify() marks one. */
const VISITOR = { kind: 'anonymous', mode: 'open' };
const AT = new Date('2026-11-12T10:03:00Z');

/* What a workbook holds: its sheet names, its properties, each sheet's XML. */
function opened(buf) {
  const files = unzip(Buffer.from(buf));
  const text = (n) => (files.get(n) ? files.get(n).toString('utf8') : '');
  const names = [...text('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  const sheets = names.map((_, i) => text(`xl/worksheets/sheet${i + 1}.xml`));
  return { names, core: text('docProps/core.xml'), sheets };
}

console.log('\n1. the stamp');
{
  check('nobody to name: no stamp', exportStamp({}) === null && exportStamp({ fm: { kind: 'anonymous' } }) === null
    && exportStamp({ fm: { kind: 'system' } }) === null);
  const s = exportStamp({ fm: PERSON }, AT);
  check('a signed-in person: name, email and the time in Dubai and UTC',
    s.who === 'Test Ops (ops@example.test)' && s.at === '2026-11-12T10:03:00Z' && /12 Nov 2026, 14:03/.test(s.dubai)
      && s.line === 'Exported by Test Ops (ops@example.test) on 12 Nov 2026, 14:03 Dubai time (2026-11-12T10:03:00Z). FleetMirror', s.line);
  const d = exportStamp({ fm: { kind: 'device', device: { id: 3, name: 'Office wall' } } }, AT);
  check('a wall screen is named as the screen', /the screen “Office wall”/.test(d.line));
  const p = exportStamp({ fm: { ...PERSON, access: { preview: 'DSP' } } }, AT);
  check('an Owner previewing a role is stamped as themselves, previewing', /previewing the DSP role/.test(p.line));
  const odd = exportStamp({ fm: { kind: 'user', user: { id: 9, email: 'x@example.test', name: 'A "quoted", name\nwith a break' } } }, AT);
  const line = csvStampLine(odd);
  check('the CSV line is one quoted cell: quotes doubled, no line break inside',
    line.startsWith('"# Exported by A ""quoted"", name with a break') && line.endsWith('"\n') && line.split('\n').length === 2, line);
}

console.log('\n2. a stamped workbook, and an unstamped one');
{
  const plain = new Workbook({ created: AT });
  plain.sheet('Data').header(['Day', 'Trips'], ['date', 'int']).row(['2026-11-12', 3]);
  const a = opened(plain.toBuffer());
  check('unstamped: no extra sheet, no footer, no "last modified by" — as before',
    a.names.join() === 'Data' && !/headerFooter/.test(a.sheets[0]) && !/lastModifiedBy/.test(a.core));
  const wb = new Workbook({ created: new Date() });
  wb.sheet('Data').header(['Day', 'Trips'], ['date', 'int']).row(['2026-11-12', 3]);
  wb.sheet('Notes').text('a note');
  stampWorkbook(wb, exportStamp({ fm: PERSON }, AT), { what: 'A test file', asked: { from: '2026-11-01', to: '2026-11-12', _: '123' } });
  const b = opened(wb.toBuffer());
  check('stamped: the file’s own properties name who and when',
    /<dc:creator>Test Ops \(ops@example.test\) via FleetMirror<\/dc:creator>/.test(b.core)
      && /<cp:lastModifiedBy>Test Ops \(ops@example.test\)<\/cp:lastModifiedBy>/.test(b.core)
      && /<dc:description>Exported by Test Ops/.test(b.core) && /2026-11-12T10:03:00Z/.test(b.core), b.core);
  /* REVERSION: drop headerFooter in Sheet.xml. */
  check('…every sheet’s print footer says so', b.sheets.every((x) => /<headerFooter><oddFooter>&amp;LExported by Test Ops on 12 Nov 2026, 14:03 Dubai time<\/oddFooter><\/headerFooter><\/worksheet>$/.test(x)),
    b.sheets.map((x) => x.slice(-160)).join(' | '));
  check('…and a last sheet spells it out, leaving every other sheet where it was',
    b.names.join() === 'Data,Notes,Exported by' && /Test Ops/.test(b.sheets[2]) && /ops@example.test/.test(b.sheets[2])
      && /from=2026-11-01&amp;to=2026-11-12/.test(b.sheets[2]) && !/_=123/.test(b.sheets[2]), b.names.join());
  const clash = new Workbook();
  clash.sheet('Exported by').text('a sheet of that name already');
  stampWorkbook(clash, exportStamp({ fm: PERSON }, AT));
  check('a sheet already named so is not clobbered', clash.sheets.map((s) => s.name).join() === 'Exported by,Exported by (2)');
}

/* ══ 3. every route that hands back a file ══════════════════════════════ */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let n = 0;
const trip = (fleet, platform, at, price = 30) => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status,
                     distance_km, price, currency, product, payment_type, pickup_addr, dropoff_addr)
   VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz + interval '18 min','completed',12.5,$8,'AED','UberX','app','A, Dubai','B, Dubai')`,
  [platform, fleet, `x${++n}`, `d-${fleet}`, `Test Driver ${fleet}`, `L${100 + n}`, at, price]);
await trip('ecosine', 'uber', '2026-10-05T09:00:00+04');
await trip('egari', 'uber', '2026-10-05T10:00:00+04');
await trip('egari', 'bolt', '2026-10-06T11:00:00+04');
const { saveTarget } = await import('../api/revenue_target.js');
await saveTarget(q, { month: '2026-10', gross: 6200, now: new Date('2026-10-01T10:00:00+04:00'), by: 7, byLabel: 'owner@example.test' });
const [watch] = await q(`INSERT INTO lowperf_watch (name, saved_day, period_from, period_to) VALUES ('Test list', '2026-10-07', '2026-10-01', '2026-10-06') RETURNING id`);
await q(`INSERT INTO agent_conversation (id, owner) VALUES ('conv-test-1', 'u:21')`);
await q(`INSERT INTO agent_result (conversation_id, rid, body) VALUES
  ('conv-test-1', 'r1', '{"kind":"file","title":"Trips by day","sheets":["r2"]}'),
  ('conv-test-1', 'r2', '{"definition":"Trips by day","columns":[{"key":"day","label":"Day","kind":"date"},{"key":"n","label":"Trips","kind":"int"}],"rows":[{"day":"2026-10-05","n":2}]}')`);

const { mountAll } = await import('./mount.mjs');
let as = null;   // who the next request is from, as the gate would set it
const api = await mountAll(db, { pre: (app) => app.use((req, _res, next) => { if (as) req.fm = as; next(); }) });
const fetchAs = async (who, p) => {
  as = who;
  try {
    const r = await fetch(`http://127.0.0.1:${api.port}${p}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || '', buf };
  } finally { as = null; }
};

console.log('\n3. every route that hands back a file');
{
  const csvAnon = await fetchAs(VISITOR, '/api/export/trips.csv?from=2026-10-05&to=2026-10-06&grain=trip');
  const csvMine = await fetchAs(PERSON, '/api/export/trips.csv?from=2026-10-05&to=2026-10-06&grain=trip');
  const [first, second] = csvMine.buf.toString('utf8').split('\n');
  check('a visitor gets no stamp: the trip CSV opens with its header, as it always did',
    csvAnon.status === 200 && csvAnon.buf.toString('utf8').startsWith('day,fleet,channel,trip_id'), csvAnon.buf.toString('utf8').slice(0, 80));
  check('the trip CSV opens with who exported it, then the header',
    csvMine.status === 200 && /^"# Exported by Test Ops \(ops@example.test\) on /.test(first) && second.startsWith('day,fleet,channel,trip_id')
      && csvMine.buf.toString('utf8').split('\n').length === csvAnon.buf.toString('utf8').split('\n').length + 1, first);

  const files = [
    ['the money workbook', '/api/export/money.xlsx?from=2026-10-01&to=2026-10-06'],
    ['the Today workbook', '/api/export/today.xlsx'],
    ['the month target workbook', '/api/export/target-month.xlsx?month=2026-10'],
    ['the low performers', '/api/export/lowperf.xlsx?from=2026-10-01&to=2026-10-06&asof=2026-10-07'],
    ['a watch list', `/api/export/lowperf-watch.xlsx?id=${watch.id}`],
    ['the assistant’s workbook', '/api/agent/file/conv-test-1/r1.xlsx'],
  ];
  for (const [what, path] of files) {
    const mine = await fetchAs(PERSON, path);
    if (mine.status !== 200 || !/spreadsheetml/.test(mine.type)) {
      check(`${what} is stamped`, false, `${mine.status} ${mine.buf.toString('utf8').slice(0, 200)}`);
      continue;
    }
    const m = opened(mine.buf);
    check(`${what} is stamped: properties, every sheet’s footer and a last sheet`,
      m.names[m.names.length - 1] === 'Exported by' && /Test Ops/.test(m.core)
        && m.sheets.every((x) => /<oddFooter>&amp;LExported by Test Ops/.test(x)), `${m.names.join()} | ${m.core.slice(0, 200)}`);
    if (path.startsWith('/api/agent/')) continue;   // a visitor's conversation is their own cookie's; asked above as the person
    const anon = await fetchAs(VISITOR, path);
    const a = anon.status === 200 ? opened(anon.buf) : null;
    check(`…and the visitor’s copy of ${what} is as it was`, a && !a.names.includes('Exported by') && !/Test Ops/.test(a.core)
      && a.sheets.every((x) => !/headerFooter/.test(x)) && a.names.length === m.names.length - 1, a ? a.names.join() : `${anon.status}`);
  }
}

api.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
