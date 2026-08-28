/* ── the other half of the market ─────────────────────────────────────────
   Every page in this product measures demand. Nothing measured supply, because
   until the availability collector landed there was nothing to measure it
   with — and the number turns out to be the largest in the business: across
   the six busiest drivers on production, 78–83% of their online time is spent
   available and not dispatched.

   Those are the best people. The fleet is paying for supply it is not selling,
   four hours in five, and until now that fact lived only on individual driver
   pages, one person at a time.

   Two questions, because the finding is only useful as a decision:
     WHEN  online driver-hours against jobs, so an over-supplied slot is
           visible as one rather than as a quiet hour
     WHERE how long the wait is after a dropoff in each area — the
           repositioning question, in the only geography this data has */
import { el, esc, panel, loading, note, tableFrom, fmt, empty, verdict, foldRows,
  plural, countOf } from './ui.js';
import { q, href } from './data.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/* The grid. Not the existing heatmap with a second colour bolted on: this
   draws the RATIO — jobs per online hour — because that is the thing a rota
   can act on, and because the two raw counts are on scales that cannot share a
   legend (driver-hours run to hundreds, jobs to tens).

   A cell with no supply data is not a cell with no supply. Uber serves 31 days
   of availability; before the collector started there is demand and nothing to
   compare it against, and those cells are left blank rather than drawn as an
   infinitely under-supplied hour. */
function balanceGrid(host, cells) {
  const by = new Map(cells.map((c) => [`${c.dow}|${c.h}`, c]));
  const rates = cells.filter((c) => c.jobs_per_online_h != null && c.online_h >= 1)
    .map((c) => c.jobs_per_online_h).sort((a, b) => a - b);
  if (!rates.length) return empty(host, 'No hour in this window has both supply and demand.');
  const med = rates[Math.floor(rates.length / 2)];
  const hi = rates[Math.floor(rates.length * 0.9)] || med;

  const wrap = el('div', 'sup-grid');
  const head = el('div', 'sup-row sup-head');
  head.innerHTML = '<i></i>' + Array.from({ length: 24 }, (_, h) =>
    `<b>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</b>`).join('');
  wrap.append(head);
  for (let d = 0; d < 7; d++) {
    const row = el('div', 'sup-row');
    row.innerHTML = `<i>${DOW[d]}</i>` + Array.from({ length: 24 }, (_, h) => {
      const c = by.get(`${d}|${h}`);
      if (!c || c.online_h < 1) {
        return `<span class="sup-c none" title="${DOW[d]} ${hh(h)} — no availability collected"></span>`;
      }
      const r = c.jobs_per_online_h ?? 0;
      /* Five bands off the fleet's own median, not an absolute scale: what
         counts as under-sold is a property of this fleet, and an absolute
         threshold would be a number somebody made up. */
      const band = r === 0 ? 0 : r < med * 0.5 ? 1 : r < med ? 2 : r < hi ? 3 : 4;
      return `<span class="sup-c b${band}" title="${DOW[d]} ${hh(h)} · ${fmt(c.online_h, 1)} online h `
        + `across ${c.drivers} drivers · ${fmt(c.jobs)} jobs · ${fmt(r, 2)} jobs per online hour `
        + `· ${fmt(c.idle_h, 1)} h idle"></span>`;
    }).join('');
    wrap.append(row);
  }
  host.append(wrap);
  const lg = el('div', 'lgnd sup-lgnd');
  lg.innerHTML = '<span><i class="sw b0"></i>no job at all</span>'
    + '<span><i class="sw b1"></i>well under</span><span><i class="sw b2"></i>under</span>'
    + `<span><i class="sw b3"></i>around the median (${fmt(med, 2)}/h)</span>`
    + '<span><i class="sw b4"></i>best sold</span>'
    + '<span><i class="sw none"></i>no availability collected</span>';
  host.append(lg);
}

export async function renderSupply(root) {
  root.innerHTML = '';
  const vHost = el('div'); root.append(vHost);
  const gridP = panel('Every hour of the week, by how well the supply sold',
    'Jobs per online hour. Two slots with ten jobs are the same colour on a demand heatmap and '
    + 'opposite problems here — one had four drivers online and one had forty.');
  root.append(gridP.panel);
  const areaP = panel('Where the waiting happens',
    'How long a driver waits after finishing a job in each area, before their next request.');
  root.append(areaP.panel);
  [gridP.body, areaP.body].forEach(loading);

  const [bal, areas] = await Promise.all([
    q('/api/supply/balance'),
    q('/api/supply/areas').catch(() => ({ areas: [] })),
  ]);

  if (!bal.covered) {
    vHost.append(note('Driver availability has not been collected for this window. Uber serves the '
      + 'last 31 days and nothing older, so this page fills in going forward and cannot be '
      + 'backfilled past that.', 'warn'));
  }

  const t = bal.totals;
  /* The worst slot that is actually a slot: enough supply for the ratio to
     mean something. One driver online for an hour with no job is not an
     over-supplied hour, it is one person. */
  const real = bal.cells.filter((c) => c.online_h >= 3);
  const worst = [...real].sort((a, b) => b.idle_h - a.idle_h)[0];
  const best = [...real].filter((c) => c.jobs_per_online_h != null)
    .sort((a, b) => b.jobs_per_online_h - a.jobs_per_online_h)[0];

  verdict(vHost, {
    claim: t.idle_pct != null
      ? `${t.idle_pct}% of the hours drivers are online, nobody is in the car`
      : `${fmt(t.jobs)} jobs in this window`,
    figure: t.jobs_per_online_h != null ? fmt(t.jobs_per_online_h, 2) : fmt(t.jobs),
    unit: t.jobs_per_online_h != null ? 'jobs per online hour' : 'jobs',
    tone: t.idle_pct != null && t.idle_pct >= 70 ? 'warn' : null,
    meta: `${fmt(t.online_h)} online h · ${fmt(t.on_job_h)} on job`,
    sub: `${fmt(t.idle_h)} driver-hours were available and not dispatched.`
      + (worst ? ` The worst single hour of the week is ${DOW[worst.dow]} ${hh(worst.h)} — `
        + `${fmt(worst.idle_h, 1)} idle hours against ${fmt(worst.jobs)} ${plural(worst.jobs, 'job')}.` : '')
      + (best ? ` The best is ${DOW[best.dow]} ${hh(best.h)} at ${fmt(best.jobs_per_online_h, 2)} `
        + 'jobs an online hour.' : ''),
    recommend: worst && best && best.jobs_per_online_h > 0
      ? `An hour moved from ${DOW[worst.dow]} ${hh(worst.h)} to ${DOW[best.dow]} ${hh(best.h)} is worth `
        + `about ${fmt(best.jobs_per_online_h - (worst.jobs_per_online_h ?? 0), 2)} more jobs.`
      : null,
  });

  gridP.body.innerHTML = '';
  balanceGrid(gridP.body, bal.cells);
  gridP.body.append(el('p', 'cap', esc(bal.basis)));

  areaP.body.innerHTML = '';
  if (!areas.areas?.length) {
    areaP.body.append(note('Not enough completed jobs with a dropoff address to measure waiting by area.'));
  } else {
    const tbl = tableFrom(areas.areas, [
      { label: 'Area', key: 'area' },
      { label: 'Waits', key: 'waits', num: true },
      { label: 'Median wait', key: 'median_wait_min', num: true,
        render: (r) => `${fmt(r.median_wait_min)} min` },
      { label: 'Mean wait', key: 'mean_wait_min', num: true,
        render: (r) => `${fmt(r.mean_wait_min)} min` },
      { label: 'Hours waited', key: 'waiting_h', num: true,
        render: (r) => `${fmt(r.waiting_h, 1)} h` },
    ], { sortable: true, sortId: 'suparea', defaultSort: { key: 'waiting_h', dir: 'desc' } });
    foldRows(areaP.body, tbl, { shown: 12, total: areas.areas.length, noun: 'area', key: 'supply-areas' });
    areaP.body.append(el('p', 'cap', esc(areas.basis)));
  }

  const links = el('p', 'cap');
  links.innerHTML = `<a class="lnk" href="${href('demand')}">Demand</a> shows when the work arrives; `
    + `<a class="lnk" href="${href('capacity')}">Rota gaps</a> sizes the hours that need more people. `
    + 'This page is the two of them against each other.';
  root.append(links);
}
