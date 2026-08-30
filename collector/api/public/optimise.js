/* Where to put the cars, and when.
   ─────────────────────────────────────────────────────────────────────────
   Every other page here reports what happened. This one exists to be acted
   on before the next shift, against one objective the operator stated
   plainly: the most trips for the least downtime.

   The number that makes it worth a page: measured over the drivers this fleet
   has availability data for, four hours in five of paid online time are idle.
   That is not a rounding error to be optimised at the margin — it is the
   business.

   Two measurements, and the page is careful which it leads with.

     The CAR's own gap — the minutes between one drop-off and that vehicle's
     next pick-up — is name-proof. It follows a plate, so it does not care
     what the two addresses were called.

     The AREA arithmetic — bookings starting where no car had landed — is
     easier to act on and is wrong in a specific way this page has to say out
     loud: Terminal 3 is written both "Dubai Int'l Airport" and "Al Garhoud",
     so the ranking put one at the top of the shortfalls and the other at the
     top of the surpluses. It is shown second, with the warning attached.

   The AI layer proposes the reading; the numbers stay the numbers. Nothing on
   this page is generated — the sentences are composed from the same figures
   the tables show, so a reader can check any claim against the row under it. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, verdict, pill, plural, countOf } from './ui.js';
import { fmt, empty, heatmap } from './charts.js';
import { q, href } from './data.js';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const D3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const when = (r) => `${D3[r.dow]} ${hh(r.h)}`;
const num = (v) => (v == null ? null : Number(v));

/* The fleet's own median, not a target from outside it. A slot below it is
   under-performing against the same fleet on a different day, which is the
   only benchmark this data can support. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function renderOptimise(root) {
  root.innerHTML = '';
  loading(root);
  const [opt, bal] = await Promise.all([
    q('/api/optimise').catch((e) => ({ error: e.message })),
    q('/api/supply/balance').catch(() => null),
  ]);
  root.innerHTML = '';
  if (opt?.error) { root.append(note(`Could not compute this: ${opt.error}`, 'err')); return; }

  /* A cell of /api/supply/balance is PER OCCURRENCE of its weekday — that is
     what makes a Tuesday comparable to a Thursday in a 30-day window that
     holds five of one and four of the other. It is emphatically NOT the
     window's total: summing the 168 cells gives roughly one week of hours,
     and this page used to print that sum as "online hours measured" and size
     its upside against it, understating both by about four times. The
     ranking and the heatmap keep the per-occurrence rate; every ABSOLUTE
     figure below comes from the route's own totals, or is rebuilt by
     multiplying each cell back out by its occurrences. */
  const cells = (bal?.cells || []).filter((c) => Number(c.online_h) > 5);
  const occ = (c) => Number(c.occurrences || 1);
  const T = bal?.totals || null;
  const onlineH = T ? Number(T.online_h)
    : cells.reduce((a, c) => a + Number(c.online_h || 0) * occ(c), 0);
  const jobH = T ? Number(T.on_job_h)
    : cells.reduce((a, c) => a + Number(c.on_job_h || 0) * occ(c), 0);
  const idleH = T && T.idle_h != null ? Number(T.idle_h) : onlineH - jobH;
  const idlePct = T && T.idle_pct != null ? Math.round(Number(T.idle_pct))
    : (onlineH ? Math.round((idleH / onlineH) * 100) : null);
  const rates = cells.map((c) => Number(c.jobs_per_online_h));
  const med = median(rates);
  const best = [...cells].sort((a, b) => b.jobs_per_online_h - a.jobs_per_online_h)[0];
  const worst = [...cells].filter((c) => c.online_h > 20)
    .sort((a, b) => a.jobs_per_online_h - b.jobs_per_online_h)[0];

  /* The ceiling, stated the only way it can be honestly stated: every slot
     below the fleet's own median, lifted to that median, on the online hours
     that were ALREADY being paid for. No new drivers, no new cars, no
     assumption that demand is infinite — just the fleet matching itself. */
  const below = cells.filter((c) => c.jobs_per_online_h < med);
  const upside = below.reduce((a, c) => a + (med - c.jobs_per_online_h) * Number(c.online_h) * occ(c), 0);
  const belowOnlineH = below.reduce((a, c) => a + Number(c.online_h) * occ(c), 0);
  const jobsSeen = T ? Number(T.jobs) : cells.reduce((a, c) => a + Number(c.jobs || 0) * occ(c), 0);

  /* Only claim a spread when both ends of it exist. With one weekday-hour of
     availability there is no "worst with real supply", and the sentence used
     to render as "turns — — the same fleet, —× apart". */
  const spread = best && worst
    ? `The best hour of the week turns ${Number(best.jobs_per_online_h).toFixed(2)} jobs out of `
      + `each online hour and the worst with real supply turns `
      + `${Number(worst.jobs_per_online_h).toFixed(2)} — the same fleet, `
      + `${(best.jobs_per_online_h / worst.jobs_per_online_h).toFixed(1)}× apart.`
    : best
      ? `The best hour of the week turns ${Number(best.jobs_per_online_h).toFixed(2)} jobs out of `
        + 'each online hour; too few hours carry enough supply to name a worst one against it.'
      : 'No weekday-hour carries enough online time to rank.';

  verdict(root, {
    claim: idlePct ? `${idlePct}% of the hours this fleet pays for are idle`
      : 'Availability is not being collected yet',
    figure: opt.median_wait_overall != null ? `${opt.median_wait_overall} min` : '—',
    unit: 'between one job and the next',
    tone: idlePct >= 70 ? 'warn' : null,
    meta: `${fmt(Math.round(onlineH))} online hours measured`,
    sub: idlePct
      ? `${fmt(Math.round(jobH))} of ${fmt(Math.round(onlineH))} online hours were spent on a job. `
        + spread
      : 'The driver availability collector has written nothing for this window, so idle time '
        + 'cannot be separated from time off.',
    recommend: upside > 0
      ? `Bringing every below-median hour up to the fleet's OWN median is `
        + `${fmt(Math.round(upside))} more ${plural(Math.round(upside), 'trip')} a month `
        + `(${Math.round((upside / Math.max(1, jobsSeen)) * 100)}% on the ${fmt(Math.round(jobsSeen))} `
        + 'this view covers) on hours already being paid for — no extra driver, no extra car.'
      : null,
  });

  root.append(kpiRow([
    { label: 'Idle, between jobs', value: `${fmt(opt.idle_h_between_jobs)} h`,
      sub: `over ${fmt(opt.handovers)} handovers`, tone: 'warn' },
    /* Shown next to the idle figure, not subtracted from it: this is a name
       match on an address, so it is an upper bound on charging, and netting
       it off silently would turn a caveat into a claim. */
    { label: 'Of that, where a charger is', value: opt.idle_h_at_charging_sites != null
      ? `${fmt(opt.idle_h_at_charging_sites)} h` : '—',
      sub: opt.idle_h_charging_pct != null
        ? `${opt.idle_h_charging_pct}% — may be refuelling, not waiting` : null },
    { label: 'Median wait', value: opt.median_wait_overall != null ? `${opt.median_wait_overall} min` : '—',
      sub: 'drop-off to next pick-up' },
    { label: 'Best hour of the week', value: best ? Number(best.jobs_per_online_h).toFixed(2) : '—',
      sub: best ? `${when(best)} · jobs per online hour` : null, tone: 'good' },
    { label: 'Worst with real supply', value: worst ? Number(worst.jobs_per_online_h).toFixed(2) : '—',
      sub: worst ? `${when(worst)} · ${fmt(Math.round(worst.idle_h))} idle hours` : null, tone: 'bad' },
    { label: 'The gap to itself', value: upside ? `+${fmt(Math.round(upside))}` : '—',
      sub: 'trips a month at the fleet median' },
  ]));

  /* When to be out. The heatmap the rota is written against — jobs won per
     online hour, so a cell is a RATE and a thin Tuesday does not out-rank a
     busy one just for being busy. */
  const hm = panel('When an online hour actually sells',
    'Jobs won per hour online, by weekday and hour. Darker is a better hour to be working. '
    + 'A rate, not a count — an hour with two drivers and one job beats an hour with twenty and five.');
  root.append(hm.panel);
  if (cells.length) {
    /* The heatmap keys on `trips`, which is what every other caller feeds it.
       The value here is a RATE, so it carries its own unit and formatter
       rather than being rounded into a count that would read as "0 jobs". */
    heatmap(hm.body, cells.map((c) => ({ dow: c.dow, h: c.h, trips: Number(c.jobs_per_online_h) })),
      { unit: 'jobs per online hour',
        valueFmt: (v) => v.toFixed(2),
        onClick: (c) => { location.hash = href('slot', String(c.dow), String(c.h)); } });
    hm.body.append(el('p', 'cap',
      `Fleet median ${med != null ? med.toFixed(2) : '—'} jobs an online hour. `
      + `${countOf(below.length, 'weekday-hour')} sit below it, holding `
      + `${fmt(Math.round(belowOnlineH))} online hours between them. `
      + 'Click a cell for who was working it.'));
  } else empty(hm.body, 'No availability has been collected for this window.');

  /* Where the downtime is. The name-proof measurement leads. */
  const w = panel('Where the waiting happens',
    'Each vehicle followed from one drop-off to its next pick-up. This counts a CAR, not an '
    + 'address, so two providers writing the same place two different ways cannot distort it. '
    + 'Gaps over four hours are a shift ending, not a wait, and are excluded.');
  root.append(w.panel);
  /* Said before the ranking, not after it. A reader who acts on the top rows
     without knowing a charger stands in two of them would move the cars away
     from the only place this largely-electric fleet can refuel. */
  if ((opt.charging_sites || []).length) {
    const alias = (opt.charging_aliases || [])
      .map((a) => `${a.site} is written ${a.written.map((n) => `“${n}”`).join(' and ')}`)
      .join('; ');
    w.body.append(note(`${opt.charging_sites.join(' and ')} hold charging stations, so idle `
      + 'time in those rows mixes waiting for work with plugging in — '
      + `${opt.idle_h_at_charging_sites != null ? `${fmt(opt.idle_h_at_charging_sites)} hours ` : ''}`
      + `${opt.idle_h_charging_pct != null ? `(${opt.idle_h_charging_pct}% of all the waiting) ` : ''}`
      + 'sit in an area with one. That is an upper bound: this matches the area '
      + 'written in the address, not a plug event, so it says a charger was '
      + `nearby and never that the car was on it.${alias ? ` ${alias}, and rows `
        + 'under either name are attributed to that one site.' : ''} `
      + 'Do not reposition out of a flagged row without checking the charge '
      + 'plan first.', 'warn'));
  }
  const waits = (opt.waits || []).map((r) => ({ ...r, _when: when(r) }));
  if (waits.length) {
    /* One slice, counted and shown. The note used to total a different number
       of rows than the table printed, which is exactly the kind of arithmetic
       a reader checks first. */
    const top = waits.slice(0, 20);
    const topIdle = top.reduce((a, r) => a + Number(r.idle_h || 0), 0);
    w.body.append(note(`The ${countOf(top.length, 'place-hour')} below hold `
      + `${fmt(Math.round(topIdle))} of the fleet's `
      + `${fmt(opt.idle_h_between_jobs)} idle hours — ${Math.round((topIdle / Math.max(1, opt.idle_h_between_jobs)) * 100)}% `
      + `of all the waiting, in ${top.length} cells of a 168-cell week.`
      + (opt.totals?.waits > top.length
        ? ` ${countOf(opt.totals.waits, 'place-hour')} had a measurable wait; these are the worst.`
        : '')));
    w.body.append(tableFrom(top, [
      { label: 'When', key: '_when' },
      /* `render` is written straight into the cell, so it is HTML — the area
         name has to be escaped by hand here. */
      { label: 'Where the car was left', key: 'area',
        render: (r) => (r.charging_site
          ? `${esc(r.area)} <span class="tag">${r.charging_site === r.area
            ? 'charger' : `charger · ${esc(r.charging_site)}`}</span>`
          : esc(r.area)) },
      { label: 'Idle hours', key: 'idle_h', num: true, render: (r) => fmt(r.idle_h) },
      { label: 'Handovers', key: 'handovers', num: true, render: (r) => fmt(r.handovers) },
      { label: 'Median wait', key: 'median_wait_min', num: true,
        render: (r) => `${fmt(r.median_wait_min)} min` },
    ], { compact: true }));
  } else empty(w.body, 'No vehicle completed two bookings in this window.');

  /* The area arithmetic, second, with its flaw stated before the table. */
  const m = panel('Work that started where no car was standing',
    'Bookings beginning in an area, against cars that finished a trip there in the hour before.');
  root.append(m.panel);
  m.body.append(note('Read this one carefully. An area here is text parsed out of an address, and '
    + 'two providers write one place two ways — Terminal 3 is addressed both as Dubai Int’l '
    + 'Airport and as Al Garhoud, which is why they can appear as a shortfall and a surplus at the '
    + 'same hour. The table above does not have that problem; this one is the easier read, not the '
    + 'sounder one.', 'warn'));
  const moves = (opt.moves || []).map((r) => ({ ...r, _when: when(r) }));
  if (moves.length) {
    m.body.append(tableFrom(moves.slice(0, 15), [
      { label: 'When', key: '_when' },
      { label: 'Area', key: 'area' },
      { label: 'Bookings', key: 'pickups', num: true, render: (r) => fmt(r.pickups) },
      { label: 'Cars already there', key: 'arrivals', num: true, render: (r) => fmt(r.arrivals) },
      { label: 'Short by, each time', key: 'gap_per_occurrence', num: true,
        render: (r) => fmt(r.gap_per_occurrence) },
      /* The base, not just the rate. "AED 0" over a place-hour where two of
         fifteen bookings carry a price is a different statement from "AED 0"
         over fifteen that all do, and the column cannot be read without it. */
      { label: 'Average fare', key: 'avg_fare', num: true,
        absent: 'no booking in any of these areas reports a fare',
        render: (r) => (r.avg_fare == null
          ? '<span class="dim">no price reported</span>'
          : `AED ${fmt(r.avg_fare)}`
            + (Number.isFinite(+r.priced_pickups)
              ? `<span class="dim"> · ${fmt(r.priced_pickups)} of ${fmt(r.pickups)}</span>` : '')) },
    ], { compact: true }));
    m.body.append(el('p', 'cap',
      `${fmt(opt.empty_arrivals)} of ${fmt(opt.placed_bookings)} placeable bookings `
      + `(${opt.empty_arrival_pct}%) began where no car had finished a trip in the hour before. `
      + 'Arrivals are an upper bound on cars present, so that share is a floor.'
      + (opt.totals?.moves > 15
        ? ` ${countOf(opt.totals.moves, 'place-hour')} ran short of a car; the fifteen worst are above.`
        : '')));
  } else empty(m.body, 'No area produced enough bookings to rank.');

  root.append(el('p', 'cap',
    'Every figure on this page is over the window and channels selected above. '
    + `${countOf(opt.areas_seen || 0, 'area')} and ${countOf(opt.slots_seen || 0, 'place-hour')} were read.`));
}
