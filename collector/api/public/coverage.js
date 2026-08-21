/* Coverage — the difference between a quiet week and a week we did not collect.
   ──────────────────────────────────────────────────────────────────────────
   Every trend line in this dashboard is a count of rows in a table. When a
   collector stops, the count goes to zero and the chart draws a collapse. This
   fleet has a real one: the Uber backfill holds thousands of trips in June and
   thousands in August, and nothing at all between 16 July and 2 August. Read
   off the Overview that is a business in freefall; read off this page it is
   eighteen days nobody fetched.

   Nothing else in the product distinguishes the two, so every rate computed
   across a hole here is wrong, and the honest thing to do is show the hole. */

import { empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, dayStr } from './ui.js';
import { q } from './data.js';

export async function renderCoverage(root) {
  root.innerHTML = '';
  loading(root);
  const c = await q('/api/coverage/calendar');
  root.innerHTML = '';
  if (!c.sources.length) return empty(root, 'No source has written a dated row in this window');

  const holed = c.sources.filter((s) => s.missing_days > 0);
  root.append(kpiRow([
    { label: 'Sources with data', value: fmt(c.sources.length) },
    { label: 'Sources with a hole', value: fmt(holed.length),
      tone: holed.length ? 'warn' : 'good' },
    { label: 'Missing days', value: fmt(c.sources.reduce((a, s) => a + s.missing_days, 0)),
      sub: 'inside each source’s own collecting span', tone: holed.length ? 'warn' : null },
    { label: 'Rows in window', value: fmt(c.sources.reduce((a, s) => a + s.total_rows, 0)) },
  ]));

  /* ── the distinction that changes what you do about a hole ──────────────
     A gap in one source is a collection failure and the fix is to re-run the
     collector. The same gap in two independent providers, over the same days,
     resuming on the same day, is a fleet that was not operating — and the fix
     is to stop trying. The two look identical on a per-source calendar, and
     the wrong reading costs a week. */
  const shared = c.shared_silence || [];
  if (shared.length) {
    const { panel: sp, body: sb } = panel('Windows where every source went quiet at once',
      'Two or more independent providers, each inside its own collecting span, each seeing nothing — '
      + 'and nothing else seeing anything either');
    root.append(sp);
    sb.append(tableFrom(shared, [
      { label: 'From', key: 'from', render: (r) => dayStr(r.from) },
      { label: 'To', key: 'to', render: (r) => dayStr(r.to) },
      { label: 'Days', key: 'days', num: true },
      { label: 'Sources dark together', key: 'sources', render: (r) => esc((r.sources || []).join(', ')) },
    ]));
    const big = shared[0];
    sb.append(el('p', 'note',
      `The largest is ${fmt(big.days)} days, ${dayStr(big.from)} to ${dayStr(big.to)}, `
      + `across ${esc((big.sources || []).join(' and '))}. `
      + 'A ride-hailing report API and a telematics box do not share an outage, and they do not resume on '
      + 'the same day by coincidence. Treat a window like this as a period the fleet did not work, not as '
      + 'data to go and fetch — but confirm it against the business before writing it off, because the one '
      + 'thing that would also produce this shape is a credential that expired everywhere at once.'));
    sb.append(el('p', 'cap',
      'These days are still counted in each source’s own missing-days figure above, because from the '
      + 'collector’s point of view they are genuinely uncollected. They are shown here separately so the '
      + 'two readings do not get confused.'));
  }

  c.sources.forEach((s) => {
    const { panel: p, body } = panel(s.source,
      `${fmt(s.total_rows)} rows over ${fmt(s.days_with_data)} days · `
      + `${dayStr(s.first_day)} → ${dayStr(s.last_day)} · median ${fmt(s.median_rows_per_day)}/day`);
    // One cell per day between the first and last day this source wrote
    // anything. Intensity is rows against that source's own median, because a
    // source polling 130 vehicles every five minutes and a source pulling a
    // daily report are not comparable on an absolute scale.
    // Laid out the way a calendar is read: one column per week, one row per
    // weekday. A flat wrapping strip made an eighteen-day hole look like a
    // wrapping artefact; in week columns it is a block you cannot miss.
    const strip = el('div', 'cal');
    const seen = new Map(s.days.map((d) => [d.day, d]));
    if (s.first_day && s.last_day) {
      // Pad to the Monday on or before the first day so every row is one weekday.
      const start = new Date(Date.parse(s.first_day));
      const lead = (start.getUTCDay() + 6) % 7;
      for (let i = 0; i < lead; i++) strip.append(el('i', 'c void'));
      for (let t = Date.parse(s.first_day); t <= Date.parse(s.last_day); t += 864e5) {
        const key = new Date(t).toISOString().slice(0, 10);
        const d = seen.get(key);
        const cell = el('i', d ? 'c' : 'c gap');
        if (d) {
          // Intensity is against this source's OWN median: a tracker polling
          // 130 vehicles every five minutes and a daily report pull are not
          // comparable on an absolute scale.
          const rel = Math.min(1, d.rows / Math.max(1, s.median_rows_per_day * 1.5));
          cell.style.opacity = String(0.22 + rel * 0.78);
          cell.title = `${key} — ${fmt(d.rows)} rows, ${d.plates} vehicles, ${d.drivers} drivers`;
        } else {
          cell.title = `${key} — nothing collected`;
        }
        strip.append(cell);
      }
    }
    body.append(strip);
    if (s.gaps.length) {
      body.append(tableFrom(s.gaps, [
        { label: 'Gap starts', key: 'from', render: (g) => dayStr(g.from) },
        { label: 'Gap ends', key: 'to', render: (g) => dayStr(g.to) },
        { label: 'Days missing', key: 'days', num: true },
      ], { compact: true }));
    } else {
      body.append(el('p', 'cap', 'No missing day inside this source’s collecting span.'));
    }
    root.append(p);
  });

  root.append(note('A gap is only counted between a source’s own first and last day. A source that '
    + 'started collecting in March is not missing January — it has no history there, which is a '
    + 'different statement and belongs in a different sentence.'));
}
