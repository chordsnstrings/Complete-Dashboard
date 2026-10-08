/* THE FIRST PAGE — the month, today, and today hour by hour.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02, on what the first page is for: "this needs to be
   there so that they know what their today's target is, and what monthly
   target is and what they are moving towards. In fact it needs to be a bit
   more granular with more data. After that you can put in today's target,
   what target they should achieve within the specific hour of the day today
   to make sure we achieve the target in real time, and how much left for
   today. These are actionable data … The first page simply aligns the
   operations and everyone live updates." And: "every hour if they are on
   target or not based on hourly income of the day and possibilities.
   Including number of trips. These are separate panels each."

   So, top to bottom:
     00  THE MONTH — revenue and trips, four cells each and the month day by
         day in green and red (./target.js), then the month in figures: what
         every day left must bring, the average day, where the month lands at
         this pace, the best and worst day, each fleet's part.
     01  TODAY — the day's target, what is done, what is left, whether the
         day is ahead or behind right now, and what this hour must bring.
     02  REVENUE, HOUR BY HOUR  ┐ separate panels, one under the other (side
     03  TRIPS, HOUR BY HOUR    ┘ by side, the 24-row tables overflowed Classic
         by 82 px at 1440): each hour's target against what that hour usually
         does and what it did, on target or not, and what the hours left must
         carry (/api/target/hours, api/target_hours.js).

   EVERYONE LIVE: the page asks again every minute and redraws in place, so
   every screen that has it open says the same thing. Today is judged at the
   data's own cut — the last intraday collection that finished today, not the
   nightly catch-up and not the clock (docs/COVERAGE.md trap 46) — and says
   so; the clock only says when it last asked.

   Green and red: an hour that has ENDED is over or under its target, and the
   day so far is ahead or behind; the hour in progress and the hours to come
   are ink. An hour that has ended but whose trips are still being filed
   (Uber files a trip about half an hour after it is requested — trap 47) is
   STILL ARRIVING: its bar is grey, and its words say how it stands SO FAR
   against what the usual day had reported of it by now. Every coloured
   figure carries ▲ or ▼ and a word. Revenue today is an estimate until Uber
   publishes the day's fares (hours behind the ride; fetched hourly), and is marked ≈. */
import { api, alive, currentGen, href } from './data.js';
import { el, esc, money, countOf, sourceLabel, panel, secHead, loading, contract } from './ui.js';
import { fmt } from './charts.js';
import { targetLive, targetView, targetHtml } from './target.js';
import { todayLive } from './today.js';

export const REFRESH_MS = 60000;

/** /api/target/hours, live. */
export async function targetHoursLive() {
  const minute = Math.floor(Date.now() / 60000);
  return api(`/api/target/hours?t=${minute}`, { cache: 'no-store', quiet: true });
}

const sign = (v, f) => (v >= 0 ? `▲ ${f(v)} ahead` : `▼ ${f(-v)} behind`);
const tone = (v) => (v == null ? null : v >= 0 ? 'over' : 'under');
const trips = (v) => { if (v == null) return '—'; const n = Math.round(v) || 0; return `${fmt(n)} ${n === 1 ? 'trip' : 'trips'}`; };
const aed = (v) => (v == null ? '—' : money(v));
const approx = (v, est) => (v == null ? '—' : `${est ? '≈ ' : ''}${money(v)}`);

/* ── 00 · the month in figures ─────────────────────────────────────────── */
/** The month's detail under the cells: label | revenue | trips. */
export function monthFiguresHtml(t) {
  const s = t.summary;
  const ts = t.trips_summary;
  const rows = [];
  const row = (label, rev, tr, cls = '') => rows.push(`<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${esc(label)}</th>`
    + `<td>${rev}</td><td>${tr}</td></tr>`);
  const b = (v, t2 = null) => `<b${t2 ? ` class="tg-${t2}"` : ''}>${esc(v)}</b>`;
  const dim = (v) => `<span class="mf-dim">${esc(v)}</span>`;
  if (s) {
    row('Target for the month', `${b(money(s.month_target))} ${dim(`${money(s.rate)} a car a day over ${countOf(s.cars_now, 'car')}`)}`,
      ts ? `${b(`${t.trips_min} a day`)} ${dim(`per active driver — ${countOf(ts.today_active, 'active driver')} today`)}` : '—');
    row('Done so far', `${b(money(s.earned))} ${dim(`of ${money(s.planned)} planned to yesterday`)}`,
      ts && ts.trips != null ? `${b(fmt(ts.trips))} ${dim(`of ${fmt(ts.needed)} needed to yesterday`)}` : '—');
    row('Ahead or behind', b(sign(s.ahead, money), s.ahead >= 0 ? 'over' : (s.unsettled ? 'wait' : 'under')),
      ts && ts.trips != null ? b(sign(ts.trips - ts.needed, (v) => trips(v)), ts.trips >= ts.needed ? 'over' : (ts.unsettled ? 'wait' : 'under')) : '—');
    row('Still to go', `${b(money(s.to_go))} ${dim(`in ${countOf(s.days_left, 'day')}, today included`)}`, dim('a floor each day, not a sum'));
    row('Every day left must bring', s.per_day_left != null ? `${b(money(s.per_day_left))} ${dim('on average')}` : '—',
      ts && ts.today_target != null ? `${b(fmt(ts.today_target))} ${dim(`today — ${countOf(ts.today_active, 'active driver')} × ${t.trips_min}`)}` : '—');
    row('The average day so far', s.avg_day != null ? `${b(money(s.avg_day))} ${dim(`over ${countOf(s.days_gone, 'day')}`)}` : dim('nothing gone yet'),
      ts && ts.avg_trips_day != null ? `${b(`${fmt(ts.avg_trips_day, 1)} trips`)} ${dim(`by ${fmt(ts.avg_active, 1)} active drivers — ${fmt(ts.per_active, 1)} each`)}` : dim('nothing gone yet'));
    row('At this pace the month ends at', s.month_end_pace != null
      ? `${b(money(s.month_end_pace), s.pace_pct >= 100 ? 'over' : 'under')} ${dim(`${fmt(s.pace_pct, 1)}% of the target`)}` : dim('nothing gone yet'), '—');
    if (s.best && s.days_gone > 1) {
      row('Best day, worst day', `${b(`${s.best.label} ${money(s.best.earned)}`)} ${dim('·')} ${b(`${s.worst.label} ${money(s.worst.earned)}`)}`, '—');
    }
  } else if (ts && ts.trips != null) {
    row('Trips so far', dim(t.why || ''), `${b(fmt(ts.trips))} ${dim(`of ${fmt(ts.needed)} needed`)}`);
  }
  for (const f of t.fleets || []) {
    row(sourceLabel(f.fleet), `${b(money(f.earned))} ${dim(`this month to yesterday · ${money(f.earned_yday)} yesterday`)}`,
      `${b(fmt(f.trips))} ${dim(`trips · ${fmt(f.trips_yday)} yesterday · ${countOf(f.cars_week, 'car')} earned this week`)}`, 'mf-fleet');
  }
  if (!rows.length) return '';
  return '<table class="mf"><thead><tr><th></th><th scope="col">Revenue</th><th scope="col">Trips</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
}

/* ── 01 · today ────────────────────────────────────────────────────────── */
/** Today's five cells: target, done, left, right now, this hour. */
export function todayHtml(h) {
  const R = h.revenue || {};
  const P = h.trips || {};
  const rOk = !R.absent;
  const pOk = !P.absent;
  const est = rOk && R.estimate;
  const cell = (label, value, subs, t2 = null) => `<div class="tg-cell${t2 ? ` tg-${t2}` : ''}">`
    + `<span class="tg-l">${esc(label)}</span><b class="tg-v">${esc(value)}</b>`
    + subs.filter(Boolean).map((x) => `<span class="tg-sub${x.tone ? ` tg-${x.tone}` : ''}">${esc(x.text || x)}</span>`).join('') + '</div>';
  const cut = h.cut_by === 'collection' ? `counted to ${h.clock}, the last collection`
    : h.cut_by === 'received' ? `counted to ${h.clock}, the newest data received`
      : h.cut_by === 'last_booking' ? `counted to the last booking, ${h.clock}` : `as of ${h.clock}`;
  const cells = [
    cell('Today’s target', rOk ? aed(R.target) : trips(P.target), [
      rOk && pOk ? `${trips(P.target)} — ${countOf(P.active, 'active driver')} × ${P.min}` : null,
      !rOk ? R.absent : null]),
    cell('Done so far', rOk ? approx(R.done, est) : trips(P.done), [
      rOk && pOk ? trips(P.done) : null, cut,
      est ? 'Revenue ≈ an estimate until Uber publishes the day’s fares (fetched every hour)' : null]),
    cell('Left for today', rOk ? approx(R.left, est) : trips(P.left), [rOk && pOk ? trips(P.left) : null]),
    cell(`Right now, ${h.clock}`, rOk ? sign(R.ahead, (v) => `${est ? '≈ ' : ''}${money(v)}`) : sign(P.ahead, trips), [
      rOk ? { text: `the usual day had ${money(R.need_by_now)} reported by now` } : null,
      pOk ? { text: `${sign(P.ahead, trips)} — ${trips(P.need_by_now)} due by now`, tone: tone(P.ahead) } : null],
    tone(rOk ? R.ahead : P.ahead)),
    (() => {
      const th = (rOk ? R : P).this_hour || {};
      const end = (th.label || '').split('–')[1] || '';
      const more = (x, f) => `${f(x.this_hour?.catch_up ?? x.this_hour?.need)} more by ${end}`;
      return cell(`This hour, ${th.label || ''}`, rOk ? more(R, aed) : more(P, trips), [
        rOk && pOk ? `${more(P, trips)} — what the rest of the hour must bring to land the day` : 'what the rest of the hour must bring to land the day',
        rOk ? `its own target ${money(R.this_hour?.need)} · ${approx(R.this_hour?.done, est)} so far · usually ${money(R.this_hour?.usual)}` : null,
        pOk ? `its own target ${trips(P.this_hour?.need)} · ${trips(P.this_hour?.done)} so far · usually ${trips(P.this_hour?.usual)}` : null]);
    })(),
  ];
  return `<div class="tg-cells tg-cells5">${cells.join('')}</div>`;
}

/* ── 02 / 03 · hour by hour ────────────────────────────────────────────── */
/* Each hour: its target as an outline, what the hour usually does as a
   tick, and what it did as a bar — green over, red under once the hour has
   ended and settled, grey while its trips are still arriving, ink while it
   runs. The hours to come carry their catch-up as a dashed outline where it
   asks more than the plan. */
export function hourChart(x, { isMoney, W = 1300, every = 3 }) {
  /* Drawn at the width it is shown at (a full-width panel, ~1,300px at a
     1440 screen; the phone's card, 360), so the hour labels stay at reading
     size — the phone labels every sixth hour. */
  const H = W < 600 ? 120 : 190, pl = 6, pr = 6, pt = 10, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / 24, bw = step * 0.62;
  const hi = Math.max(1, ...x.hours.map((r) => Math.max(r.need || 0, r.done || 0, r.usual || 0, r.catch_up || 0)));
  const y = (v) => pt + ih - (ih * (v || 0)) / hi;
  const f = isMoney ? (v) => money(v) : (v) => trips(v);
  const parts = [];
  x.hours.forEach((r, i) => {
    const bx = pl + step * i + (step - bw) / 2;
    const tip = `${r.label}: target ${f(r.need)}, usually ${f(r.usual)}`
      + (r.done != null ? `, done ${isMoney && x.estimate ? '≈ ' : ''}${f(r.done)}` : '')
      + (r.state === 'arriving' ? ` so far — still arriving; the usual day had ${f(r.expect)} of it reported by now` : '')
      + (r.catch_up != null ? `, to land the day ${f(r.catch_up)}` : '');
    const g = [`<g class="hc-h hc-${r.state}"><title>${esc(tip)}</title>`];
    if (r.done != null && r.done > 0) g.push(`<rect class="hc-done" x="${bx.toFixed(1)}" y="${y(r.done).toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y(r.done)).toFixed(1)}"/>`);
    if (r.need > 0) g.push(`<rect class="hc-need" x="${bx.toFixed(1)}" y="${y(r.need).toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y(r.need)).toFixed(1)}"/>`);
    if (r.catch_up != null && r.catch_up > (r.need || 0) + 1e-6) g.push(`<rect class="hc-catch" x="${bx.toFixed(1)}" y="${y(r.catch_up).toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y(r.catch_up)).toFixed(1)}"/>`);
    if (r.usual > 0) g.push(`<line class="hc-usual" x1="${(bx - 2).toFixed(1)}" x2="${(bx + bw + 2).toFixed(1)}" y1="${y(r.usual).toFixed(1)}" y2="${y(r.usual).toFixed(1)}"/>`);
    g.push('</g>');
    parts.push(g.join(''));
    /* The first label starts at its bar, so the edge does not clip it. */
    if (i % every === 0) parts.push(`<text class="hc-x" x="${(i ? bx + bw / 2 : bx).toFixed(1)}" y="${H - 6}" text-anchor="${i ? 'middle' : 'start'}">${r.label}</text>`);
  });
  return `<svg class="hc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Each hour today: its target, what it usually does, and what it did`)}">`
    + `<line class="hc-base" x1="${pl}" x2="${W - pr}" y1="${pt + ih}" y2="${pt + ih}"/>${parts.join('')}</svg>`;
}

/** An hour's verdict in words: the same on the desktop table and the phone. */
export function statusHtml(r, plain) {
  /* Over, below its printed target: the hour has settled at or above what
     the usual day has in of it by now, and the rest of a usual hour reaches
     us later (trap 47) — said in those words, not as a bare tick. */
  return r.state === 'over' ? (r.diff < 0 && r.reported != null
    ? `<span class="tg-over">▲ On pace</span> <span class="hp-dim">· a usual day has ${Math.round(r.reported * 100)}% of it in by now</span>`
    : `<span class="tg-over">▲ On target${r.diff > 0 ? ` +${esc(plain(r.diff))}` : ''}</span>`)
    : r.state === 'under' ? `<span class="tg-under">▼ Under by ${esc(plain(-r.diff))}</span>`
      : r.state === 'arriving' ? (r.so_far === 'over' ? `<span class="tg-over">▲ On pace so far${r.diff > 0 ? ` +${esc(plain(r.diff))}` : ''}</span>`
        : `<span class="tg-under">▼ Short by ${esc(plain(-r.diff))} so far</span>`) + ' <span class="hp-dim">· still arriving</span>'
        : r.state === 'now' ? '<span class="hp-now">In progress</span>'
          : r.state === 'idle' ? '<span class="hp-dim">— nothing asked</span>' : '<span class="hp-dim">To come</span>';
}

/* The panel's first paragraph: the day so far, what is left, this hour. */
function ledeHtml(x, h, { isMoney }) {
  const est = isMoney && x.estimate;
  const f = isMoney ? (v) => `${est ? '≈ ' : ''}${money(v)}` : (v) => trips(v);
  const plain = isMoney ? (v) => money(v) : (v) => trips(v);
  return `<p class="hp-lede"><b class="tg-${tone(x.ahead)}">${esc(sign(x.ahead, f))}</b> `
    + `${esc(`at ${h.clock} — ${f(x.done)} done, ${plain(x.need_by_now)} due by now on the usual day.`)} `
    + `${esc(`Left for today: ${f(x.left)}.`)}`
    + (x.arriving ? ` ${esc(`${x.arriving === 1 ? 'The hour just gone is' : `${x.arriving} hours just gone are`} still arriving — a trip reaches us about half an hour after it is requested, so an hour is called under only once it has settled.`)}` : '')
    + (x.this_hour ? ` ${esc(`This hour, ${x.this_hour.label}: ${plain(x.this_hour.catch_up ?? x.this_hour.need)} in what is left of it to land the day (its target ${plain(x.this_hour.need)}).`)}` : '')
    + '</p>';
}

/** The phone's hourly card: the summary, the day at 360px, and the hours
    around now — the three just gone, this one, the two to come. Every hour
    is on the desktop's #target; the phone holds the ones a shift acts on. */
export function hoursNearHtml(x, h, { isMoney }) {
  if (!x || x.absent) return `<p class="tg-absent">${esc(x?.absent || 'Not measured.')}</p>`;
  const est = isMoney && x.estimate;
  const f = isMoney ? (v) => `${est ? '≈ ' : ''}${money(v)}` : (v) => trips(v);
  const plain = isMoney ? (v) => money(v) : (v) => trips(v);
  const cur = h.hour ?? 0;
  const near = x.hours.filter((r) => r.h >= cur - 3 && r.h <= cur + 2);
  const rows = near.map((r) => `<tr${r.state === 'now' ? ' class="hp-cur"' : ''}><th scope="row">${r.label}</th>`
    + `<td>${r.done == null ? '<span class="hp-dim">—</span>' : esc(f(r.done))} <span class="hp-dim">/ ${esc(plain(r.need))}</span></td>`
    + `<td>${r.catch_up != null && r.state !== 'now' ? `<span class="hp-dim">${esc(plain(r.catch_up))} to land the day</span>` : statusHtml(r, plain)}</td></tr>`).join('');
  return `${ledeHtml(x, h, { isMoney })}${hourChart(x, { isMoney, W: 360, every: 6 })}`
    + `<table class="hp hp-near"><thead><tr><th scope="col">Hour</th><th scope="col">Done / target</th><th scope="col">On target?</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

/** One hourly panel's body: the summary, the chart, the key, the hours. */
export function hoursHtml(x, h, { isMoney }) {
  if (!x || x.absent) return `<p class="tg-absent">${esc(x?.absent || 'Not measured.')}</p>`;
  const est = isMoney && x.estimate;
  const f = isMoney ? (v) => `${est ? '≈ ' : ''}${money(v)}` : (v) => trips(v);
  const plain = isMoney ? (v) => money(v) : (v) => trips(v);
  const head = ledeHtml(x, h, { isMoney });
  const key = '<p class="hp-key"><span class="hk hk-done-over"></span>done, on target'
    + '<span class="hk hk-done-under"></span>done, under<span class="hk hk-done-arriving"></span>ended, still arriving'
    + '<span class="hk hk-done-now"></span>this hour so far'
    + '<span class="hk hk-need"></span>target<span class="hk hk-catch"></span>to land the day'
    + '<span class="hk hk-usual"></span>what the hour usually does</p>';
  const rows = x.hours.map((r) => {
    const status = statusHtml(r, plain);
    const quiet = !r.need && !r.done && !r.usual ? ' class="hp-quiet"' : (r.state === 'now' ? ' class="hp-cur"' : '');
    return `<tr${quiet}><th scope="row">${r.label}</th><td>${esc(plain(r.usual))}</td><td>${esc(plain(r.need))}</td>`
      + `<td>${r.done == null ? '<span class="hp-dim">—</span>' : esc(f(r.done))}</td><td>${status}</td>`
      + `<td>${r.catch_up == null ? '<span class="hp-dim">—</span>' : esc(plain(r.catch_up))}</td>`
      + `<td>${r.cum_done == null ? '<span class="hp-dim">—</span>' : esc(`${f(r.cum_done)} / ${plain(r.cum_need)}`)}</td></tr>`;
  }).join('');
  const timing = x.timing?.why ? ` ${x.timing.why}`
    : x.timing?.days ? ` “Due by now” is what the usual day had reported by this time of day — a trip reaches us after it is over — over the ${countOf(x.timing.days, 'day')} collected live; an hour gone is still arriving while the usual day would add more of it within the hour.` : '';
  const basis = `<p class="cap hp-basis">${esc(`Each hour’s target is today’s ${plain(x.target)} × the share of a day’s ${isMoney ? 'fares' : 'completed trips'} that hour carried over the last ${countOf(x.basis?.days, 'day')} (${x.basis?.from} to ${x.basis?.to}). “To land the day” shares what is still to do over the hours left in the same proportions.${timing}`)}`
    + (est ? ` ${esc('Today’s revenue is the live strip’s estimate — fares on record plus each channel’s unpriced bookings at its settled per-booking rate — until Uber publishes the day’s fares, which are fetched every hour.')}` : '') + '</p>';
  return `${head}${hourChart(x, { isMoney })}${key}`
    + `<div class="tablewrap"><table class="hp"><thead><tr><th scope="col">Hour</th><th scope="col">Usually</th><th scope="col">Target</th>`
    + `<th scope="col">Done</th><th scope="col">On target?</th><th scope="col">To land the day</th><th scope="col">Running, done / target</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>${basis}`;
}

/* ── the page ──────────────────────────────────────────────────────────── */
/** The first page, into `root`, redrawn every REFRESH_MS while it is open. */
export async function targetPage(root) {
  const gen = currentGen();
  const ak = contract();
  const note = el('span');
  const month = el('div');
  let todayBody;
  if (ak) {
    const band = el('section', 'cband tp-month');
    band.append(secHead('00', 'The month', note), month);
    root.append(band);
  } else {
    /* The note in the panel's own caption paragraph: a bare span between the
       heading and the body sat 3px above it (test/spacing.test.mjs's rule,
       measured on #target, which test/routes_list.mjs does not walk). */
    const p = panel('The month', null, 'tp-month');
    const cap = el('p', 'cap');
    cap.append(note);
    p.panel.querySelector('h3')?.after(cap);
    p.body.append(month);
    root.append(p.panel);
  }
  const today = panel('Today', null, 'tp-today');
  todayBody = today.body;
  /* One above the other, each the page's width: seven columns of money do
     not fit half of it (at 1440 the two tables ran into each other). */
  const rev = panel('Revenue, hour by hour', null, 'tp-rev');
  const tri = panel('Trips, hour by hour', null, 'tp-trips');
  root.append(today.panel, rev.panel, tri.panel);
  [month, todayBody, rev.body, tri.body].forEach((b) => loading(b));

  const draw = async () => {
    const [t, live, h] = await Promise.all([
      targetLive({ quiet: true }).catch((e) => ({ _err: e })),
      todayLive({ quiet: true }).catch(() => null),
      targetHoursLive().catch((e) => ({ _err: e })),
    ]);
    if (!alive(gen)) return false;
    const asked = new Date(Date.now() + 4 * 3600e3).toISOString().slice(11, 16);
    if (t._err) month.innerHTML = `<p class="tg-absent">${esc(`The month could not be read: ${t._err.message || 'no answer'}`)}</p>`;
    else {
      const vm = targetView(t, live);
      month.innerHTML = (vm ? `<div class="targetnow tg-page">${targetHtml(vm, { link: (d) => href('day', d) })}</div>` : '')
        + monthFiguresHtml(t);
      note.textContent = `${t.month_name} · both fleets · gross fares before commission · updated ${asked}, again every minute`;
    }
    if (h._err) {
      const msg = `<p class="tg-absent">${esc(`Today could not be read: ${h._err.message || 'no answer'}`)}</p>`;
      todayBody.innerHTML = msg; rev.body.innerHTML = msg; tri.body.innerHTML = '';
    } else {
      todayBody.innerHTML = `<div class="targetnow tg-page">${todayHtml(h)}</div>`;
      rev.body.innerHTML = hoursHtml(h.revenue, h, { isMoney: true });
      tri.body.innerHTML = hoursHtml(h.trips, h, { isMoney: false });
    }
    return true;
  };
  await draw();
  /* Everyone live: ask again every minute while this page is the one open. */
  const timer = setInterval(async () => {
    if (!alive(gen) || document.hidden) { if (!alive(gen)) clearInterval(timer); return; }
    await draw().catch(() => {});
  }, REFRESH_MS);
}
