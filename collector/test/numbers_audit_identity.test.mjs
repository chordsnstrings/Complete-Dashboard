/* Whose row is it? — bin/numbers-audit.mjs, matched against the wrong table.
   ──────────────────────────────────────────────────────────────────────────
   The numbers audit asks "the API gave the page this figure; is it on screen
   in the row it belongs to?". Everything turns on the words "the row it
   belongs to", and on 2026-09-02 it got that wrong three times against live
   production, on three pages that were showing exactly the right numbers:

     #corporate/properties   hotel · Bookings should be 1632 (/api/platforms)
     #corporate/approach     hotel · Bookings should be 1632 (/api/platforms)
     #overview?days=90…      muhammad khalid · Km should be 3526

   Both are the same mistake — a payload row matched to a table it has nothing
   to do with — and they are two different halves of it:

   1. THE TABLE BELONGS TO ANOTHER ENDPOINT.  #corporate/properties draws one
      table, of six properties, from /api/corporate/properties over the chosen
      window. It also fetches /api/platforms, whose rows are CHANNELS over all
      time, for the provenance line at the foot of the page. The channel row
      `hotel` carries bookings 1632; the table has a Bookings column; and one
      property is called "Le Meridien Dubai Hotel & Conference Centre". So a
      channel's lifetime total was demanded of a hotel's monthly row. The page
      was right twice: its six rows sum to 899, and the line under them reads
      "Built from Uber 12,623 · Hotel 899 · Yango 36" — /api/platforms' own
      window_bookings. 1,632 belongs nowhere on that page.

   2. THE ROW BELONGS TO ANOTHER PERSON.  #overview draws twelve of the
      hundred rows /api/drivers/leaderboard returns. Rank 4 is Muhammad Khalid
      Gul (4d4eb2c1…, L94178, 9,060 km, all on screen); far below, undrawn, is
      a different man — Muhammad Khalid (76ede4ae…, L90721, 3,526 km). The
      audit already had a guard for that exact pair, and it compared the whole
      first cell against the endpoint's names. The cell reads "4Muhammad
      Khalid Gul": the rank sits in it with no separator, so the cell was not
      recognised as Gul's, the prefix match went through, and one man's
      kilometres were demanded of the other man's row.

   (Neither is an identity fold going wrong. The two men have different
   driver_ext_ids, different plates, and fold apart under BOTH rules in this
   codebase — driver_statement_day's name_key and custody_sql's personFold.)

   So this drives the real tool against a stub carrying those two shapes and
   requires silence — and against a third that genuinely hides a figure, and
   requires it to speak. A harness that stops crying wolf by going blind is
   the worse of the two failures.

       node test/numbers_audit_identity.test.mjs
*/
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}\n      ${x}`)); };

/* ── the fixture: production's own shapes, at production's own sizes ───────
   Six properties, two of whose names contain "hotel", because the ratio is
   what the fallback vote in ownersOf() weighs. The figures are the ones
   /api/corporate/properties and /api/platforms actually returned on
   2026-09-02 for the window 2026-08-04..2026-09-02. */
const PROPERTIES = [
  { partner_id: 'p1', name: 'Le Meridien Dubai Hotel & Conference Centre', bookings: 485, revenue: 32699, km: 5388 },
  { partner_id: 'p2', name: 'Office', bookings: 130, revenue: 20484, km: 4996 },
  { partner_id: 'p3', name: 'Aloft Al Mina, Dubai', bookings: 103, revenue: 9065, km: 1054 },
  { partner_id: 'p4', name: 'Driver Self-Managed Ride', bookings: 177, revenue: 4212, km: 4529 },
  { partner_id: 'p5', name: 'Renaissance Business Bay Hotel', bookings: 1, revenue: 120, km: 21 },
  { partner_id: 'p6', name: 'Other Trip', bookings: 3, revenue: 3, km: 41 },
];
/* The collector's inventory: one row per CHANNEL, all time, `bookings` 1632
   for hotel against a windowed 899. No `name` on any row — which is the fact
   that makes it un-mistakable for the source of a table of properties. */
const PLATFORMS = [
  { platform: 'uber', fleet_id: 'ecosine', bookings: 220700, rows_seen: 220700, window_bookings: 8690 },
  { platform: 'hotel', fleet_id: 'ecosine', bookings: 1632, rows_seen: 1632, window_bookings: 899 },
];
/* Two men whose names are a prefix of one another, and a third between them,
   exactly as the live leaderboard has them. Only the first two are drawn. */
const LEADERBOARD = [
  { driver_name: 'Muhammad Khalid Gul', driver_ext_id: '4d4eb2c1', plate: 'L94178', trips: 700, km: 9060 },
  { driver_name: 'Wisal Muhammad Muhammad', driver_ext_id: '64686123', plate: 'L44251', trips: 847, km: 10252 },
  { driver_name: 'Muhammad Khalid', driver_ext_id: '76ede4ae', plate: 'L90721', trips: 307, km: 3526 },
];

/* A page with the same bones the dashboard has: #view, tables whose headers
   carry data-key, a rank drawn inside the first cell with no separator. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>stub</title></head>
<body><div id="view"></div><script>
const J = (p) => fetch(p).then((r) => r.json());
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const table = (cols, rows) =>
  '<table><thead><tr>' + cols.map((c) => '<th data-key="' + c[1] + '">' + c[0] + '</th>').join('')
  + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('')
  + '</tbody></table>';
const draw = async () => {
  const route = (location.hash || '#props').slice(1).split('?')[0];
  const view = document.getElementById('view');
  if (route === 'top') {
    const [lb] = await Promise.all([J('/api/drivers/leaderboard'), J('/api/platforms')]);
    /* The rank lives INSIDE the identity cell, with no separator, which is
       how #overview's Top drivers table draws it. */
    view.innerHTML = '<h3>Top drivers</h3>' + table(
      [['Driver', 'driver_name'], ['Plate', 'plate'], ['Trips', 'trips'], ['Km', 'km']],
      lb.slice(0, 2).map((d, i) => ['<span class="rank">' + (i + 1) + '</span>' + esc(d.driver_name),
        esc(d.plate), d.trips, d.km.toLocaleString('en-US')]));
    return;
  }
  const [props, plats] = await Promise.all([J('/api/corporate/properties'), J('/api/platforms')]);
  /* 'hidden' withholds one revenue the payload gave it, and nothing else. */
  view.innerHTML = '<h3>Every property that books</h3>' + table(
    [['Property', 'name'], ['Bookings', 'bookings'], ['Revenue', 'revenue'], ['Km', 'km']],
    props.map((p) => [esc(p.name), p.bookings,
      (route === 'hidden' && p.partner_id === 'p1') ? '—' : p.revenue.toLocaleString('en-US'),
      p.km.toLocaleString('en-US')]))
    + '<p class="cap">Built from ' + plats.map((p) => p.platform + ' ' + p.window_bookings).join(' &middot; ') + '.</p>';
};
addEventListener('hashchange', draw); draw();
</script></body></html>`;

const stub = async (answers) => {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    const body = answers[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body === undefined ? { error: 'no such endpoint' } : body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
};

const s = await stub({
  '/api/corporate/properties': PROPERTIES,
  '/api/platforms': PLATFORMS,
  '/api/drivers/leaderboard': LEADERBOARD,
});
/* Its own cwd: the tool writes docs/audit/numbers-<today>.json beside
   wherever it is run, and a test must not overwrite the real report. */
const cwd = mkdtempSync(join(tmpdir(), 'numaudit-'));
const out = await new Promise((resolve) => {
  const p = spawn(process.execPath, [join(ROOT, 'bin', 'numbers-audit.mjs')], {
    cwd,
    env: { ...process.env, BASE: s.base, ONLY: 'props,top,hidden', SETTLE: '900', EXPLAIN: '1' },
  });
  let o = '';
  p.stdout.on('data', (d) => { o += d; });
  p.stderr.on('data', (d) => { o += d; });
  p.on('close', () => resolve(o));
});
s.stop();
rmSync(cwd, { recursive: true, force: true });

const compared = (route) => {
  const m = out.match(new RegExp(`\\n  ${route}: .*?→ (\\d+) compared`));
  return m ? Number(m[1]) : -1;
};

/* 1. A figure from an endpoint that did not draw this table is not owed by it. */
check('a channel total from /api/platforms is not demanded of a property row',
  !/hotel · Bookings should be 1632/.test(out), out.trim().slice(-2200));

/* 2. …and the page is still being read: the properties the table DID draw are
   compared, so silence here is silence about a page that was checked. */
check('…and the properties table is still checked (figures compared > 0)',
  compared('props') > 0, out.trim().slice(-2200));

/* 3. A name that is a prefix of a drawn row's name, in a row the table cut,
      does not borrow that row — even with the rank glued to the front of it. */
check('an undrawn driver\'s km is not demanded of the driver whose name extends his',
  !/muhammad khalid · Km should be 3526/.test(out), out.trim().slice(-2200));

check('…and the leaderboard table is still checked (figures compared > 0)',
  compared('top') > 0, out.trim().slice(-2200));

/* 4. The control. Same table, same endpoint, one figure genuinely withheld —
      this MUST still be reported, or the two silences above are blindness. */
check('a revenue the page really does withhold is still reported',
  /#hidden[\s\S]*Revenue should be 32699/.test(out), out.trim().slice(-2200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
