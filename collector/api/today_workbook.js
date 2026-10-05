/* THE TODAY WORKBOOK — what the Today page shows, as an .xlsx.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02: "Make sure from the today dashboard an excel can
   be downloaded as well." Six sheets, each the page's own figure from the
   page's own source, so the file and the screen cannot disagree:

     Target            the month's target and where it stands (api/revenue_target.js)
     Days              every day of the month: cars, plan, what it needed,
                       what it earned, over or under, settled or why not, and
                       the trips chart's own columns — trips against active
                       drivers × the minimum, over or under
     Cars yesterday    every car that earned in the 8 days to yesterday: what
                       it earned yesterday against its share of the day's need
     Drivers yesterday every active driver (the 08:00 email's rule): trips
                       yesterday against the trips minimum, and their fares,
                       with the id the dashboard finds them by
     Action list       every live finding (api/insights_sql.js — the page's
                       query, not a copy of it)
     Today so far      the live strip: bookings, trip value, fares, money in
                       (api/day_routes.js buildDay, the strip's own source)

   Plain numbers, no formulas (src/xlsx_write.js). A class a signed-in reader's
   role does not hold in full is written "(withheld)" in every cell of it —
   the money workbook's rule (api/money_export_routes.js), because the access
   layer shapes JSON and never sees the inside of a file. Driver names make the
   Action list an identity list as a whole, so without ID it is withheld whole. */
import { Workbook } from '../src/xlsx_write.js';
import { monthTarget, addDays, carsAsOf, loadFacts, shortDay, monthName, DRIVER_DAYS } from './revenue_target.js';
import { personKeyStored } from './custody_sql.js';
import { insightListSql } from './insights_sql.js';
import { buildDay } from './day_routes.js';
import { dubaiDay } from './window.js';

export const TODAY_FILE_CLASSES = ['ID', 'REV', 'EARN', 'VEH', 'BK'];
const W = '(withheld)';
const VERDICT = { over: 'over', under: 'under', unsettled: 'not settled' };

export async function buildTodayWorkbook({ q, now = new Date(), hide = new Set() }) {
  const today = dubaiDay(now);
  const yday = addDays(today, -1);
  const t = await monthTarget(q, { today, now });
  const hid = (cls, v) => (hide.has(cls) ? W : v);
  const money = (v) => hid('REV', v);
  const wb = new Workbook({ created: now });

  /* ── Target ─────────────────────────────────────────────────────────── */
  const s1 = wb.sheet('Target', { widths: [34, 22, 80] });
  s1.text(`Revenue target — ${t.month_name}`, 'title');
  s1.text(`As of ${today} (Dubai). Both fleets, every channel. Gross = fares, before any platform commission.`, 'dim');
  s1.blank();
  const sm = t.summary;
  if (!sm) {
    s1.text(t.why, 'wrap');
  } else {
    const pairs = [
      ['Month target now (AED)', money(sm.month_target), 'money', 'The sum of every day’s plan: the target as set, moved by every car that has joined or dropped out since.'],
      ['Target as set (AED)', money(sm.gross_set), 'money', `Saved on ${t.target.set_day}${t.saves.length > 1 ? `; ${t.saves.length} saves this month` : ''}.`],
      ['AED a car a day', money(sm.rate), 'money', 'Fixed at the save: the target ÷ (days in the month × cars that earned in the 7 days before it).'],
      ['Cars when set', hid('VEH', sm.cars_at_set), 'int', 'Cars that earned in the 7 days before the save.'],
      ['Cars now', hid('VEH', sm.cars_now), 'int', 'Cars that earned in the 7 days before today.'],
      ['Earned to yesterday (AED)', money(sm.earned), 'money', 'Fares on every day of the month before today.'],
      ['Planned to yesterday (AED)', money(sm.planned), 'money', null],
      ['Ahead (+) / behind (−) (AED)', money(sm.ahead), 'money', null],
      ['Still to earn (AED)', money(sm.to_go), 'money', null],
      ['Days left, today included', sm.days_left, 'int', null],
      ['Today needs (AED)', money(sm.today_needs), 'money', 'Today’s plan plus the shortfall so far shared over the days left (a surplus lowers it the same way).'],
      ['Today needs a car (AED)', money(sm.today_per_car), 'money', null],
      ['Days judged / over / under / not settled', `${sm.judged} / ${sm.over} / ${sm.under} / ${sm.unsettled}`, 'text', 'A day is judged once every channel has delivered it and 99% of its bookings carry a fare.'],
    ];
    for (const [label, v, kind, note] of pairs) s1.push([[label, 'bold'], [v, kind], [note, 'dim']]);
  }
  /* The trips chart's summary, whether or not a revenue target is set —
     the minimum always exists. */
  const ts = t.trips_summary;
  s1.blank();
  s1.text(`Trips — at least ${t.trips_min} a day per active driver`, 'bold');
  if (ts) {
    const tp = [
      ['Trips a day per active driver (minimum)', t.trips_min, 'int', 'The Access page’s minimum (the 08:00 email’s); an active driver completed a trip in the 8 days to the day.'],
      ['Trips to yesterday', hid('BK', ts.trips), 'int', null],
      ['Trips needed to yesterday', hid('BK', ts.needed), 'int', 'Each day’s active drivers × the minimum, added up. A day short is not carried into the next.'],
      ['Trips a driver a day, month so far', hid('BK', ts.per_active), 'num1', 'The month’s trips ÷ its active driver-days.'],
      ['Trip days judged / over / under / not settled', `${ts.judged} / ${ts.over} / ${ts.under} / ${ts.unsettled}`, 'text', 'Judged by the same settled rule as the revenue.'],
      ['Active drivers today', ts.today_active, 'int', null],
      ['Trips to complete today', hid('BK', ts.today_target), 'int', null],
      ['Completed today so far', hid('BK', ts.today_trips), 'int', null],
    ];
    for (const [label, v, kind, note] of tp) s1.push([[label, 'bold'], [v, kind], [note, 'dim']]);
  }

  /* ── Days ───────────────────────────────────────────────────────────── */
  const s2 = wb.sheet('Days', { widths: [11, 10, 9, 7, 11, 13, 13, 13, 13, 9, 12, 9, 46, 9, 8, 9, 9, 9, 9, 7, 12, 12] });
  s2.header(['Day', 'Weekday', 'State', 'Cars', 'AED a car', 'Plan (AED)', 'Needed (AED)', 'Earned (AED)',
    'Over (+) / under (−)', '% of need', 'Verdict', 'Settled', 'Why not settled', 'Fare cover %',
    'Trips', 'Active drivers', 'Trips needed', 'Trips a driver', `At ${t.trips_min} or more`, 'Drove',
    'Trips over (+) / under (−)', 'Trips verdict'],
  ['date', 'text', 'text', 'int', 'money', 'money', 'money', 'money', 'money', 'num1', 'text', 'text', 'wrap', 'num1',
    'int', 'int', 'int', 'num1', 'int', 'int', 'int', 'text']);
  for (const d of t.days) {
    const verdict = d.verdict ? `${VERDICT[d.verdict]}${d.provisional ? ' (at least)' : ''}` : (d.state === 'today' ? 'today — not judged' : null);
    const tv = d.trips_verdict ? `${VERDICT[d.trips_verdict]}${d.trips_provisional ? ' (at least)' : ''}` : (d.state === 'today' ? 'today — not judged' : null);
    s2.row([d.day, shortDay(d.day).split(' ')[0], d.state, hid('VEH', d.cars), money(d.rate), money(d.plan), money(d.needed),
      money(d.earned), money(d.diff), d.pct, verdict, d.settled == null ? null : (d.settled ? 'yes' : 'no'), d.why,
      d.coverage, hid('BK', d.trips), d.active_drivers, hid('BK', d.trips_target), hid('BK', d.trips_per_active),
      hid('BK', d.reached), d.drove, hid('BK', d.trips_diff), tv]);
  }

  /* ── Cars yesterday ─────────────────────────────────────────────────── */
  const facts = await loadFacts(q, addDays(yday, -(DRIVER_DAYS + 1)), today);
  const counted = carsAsOf(facts, yday);
  const yrow = t.days.find((d) => d.day === yday) || t.yesterday || null;
  const share = yrow && yrow.needed != null && yrow.cars ? Math.round((yrow.needed / yrow.cars) * 100) / 100 : null;
  const cars = await q(
    `SELECT btrim(n.plate) AS plate, mode() WITHIN GROUP (ORDER BY n.fleet_id) AS fleet,
            coalesce(round(sum(n.price) FILTER (WHERE n.has_fare AND n.local_day = $2::date)::numeric, 2), 0)::float AS earned,
            count(*) FILTER (WHERE n.local_day = $2::date)::int AS bookings,
            to_char(max(n.local_day) FILTER (WHERE n.has_fare AND n.price > 0), 'YYYY-MM-DD') AS last_earned
       FROM trip_norm n
      WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND coalesce(btrim(n.plate), '') <> ''
      GROUP BY 1
     HAVING max(n.local_day) FILTER (WHERE n.has_fare AND n.price > 0) IS NOT NULL
      ORDER BY 3, 1`, [addDays(yday, -7), yday]);
  const s3 = wb.sheet('Cars yesterday', { widths: [10, 10, 14, 10, 14, 14, 12, 40] });
  s3.text(`${shortDay(yday)}: every car that earned in the 8 days to it. Its share is what the day needed ÷ the cars counted.`, 'dim');
  s3.header(['Plate', 'Fleet', 'Earned (AED)', 'Bookings', 'Share (AED)', 'Over (+) / under (−)', 'Last earned', 'Note'],
    ['text', 'text', 'money', 'int', 'money', 'money', 'date', 'wrap']);
  for (const c of cars) {
    const inPlan = counted.has(c.plate);
    s3.row([hid('VEH', c.plate), c.fleet, money(c.earned), hid('BK', c.bookings), money(inPlan ? share : null),
      money(inPlan && share != null ? Math.round((c.earned - share) * 100) / 100 : null), c.last_earned,
      inPlan ? null : 'Not counted in the day’s cars: it had not earned in the 7 days before.']);
  }

  /* ── Drivers yesterday ──────────────────────────────────────────────── */
  /* The id beside the name (test/interlinking's rule): a row in a file
     the reader cannot click is still one they can find on the dashboard. */
  const ppl = await q(
    `SELECT ${personKeyStored('t')} AS pk,
            coalesce(mode() WITHIN GROUP (ORDER BY n.driver_name), '(unnamed)') AS name,
            mode() WITHIN GROUP (ORDER BY t.driver_ext_id) AS driver_ext_id,
            mode() WITHIN GROUP (ORDER BY n.fleet_id) AS fleet,
            count(*) FILTER (WHERE n.local_day = $2::date)::int AS yday,
            coalesce(round(sum(n.price) FILTER (WHERE n.has_fare AND n.local_day = $2::date)::numeric, 2), 0)::float AS fares,
            count(*) FILTER (WHERE n.local_day < $2::date)::int AS before,
            count(DISTINCT n.local_day) FILTER (WHERE n.local_day < $2::date)::int AS before_days
       FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
      WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
        AND n.outcome = 'completed' AND n.driver_name IS NOT NULL
      GROUP BY 1
      ORDER BY 4, 6 DESC, 2`, [addDays(yday, -(DRIVER_DAYS - 1)), yday]);
  const s4 = wb.sheet('Drivers yesterday', { widths: [32, 24, 10, 10, 9, 9, 14, 14, 12] });
  s4.text(`${shortDay(yday)}: every active driver — a completed trip in the 8 days to it, the 08:00 email’s rule. `
    + `Minimum ${t.trips_min} trips a day.`, 'dim');
  s4.header(['Driver', 'Driver id', 'Fleet', 'Trips', 'Target', 'Short by', 'Fares (AED)', 'Trips, 7 days before', 'Days driven'],
    ['text', 'text', 'text', 'int', 'int', 'int', 'money', 'int', 'int']);
  for (const p of ppl) {
    s4.row([hid('ID', p.name), hid('ID', p.driver_ext_id), p.fleet, hid('BK', p.yday), t.trips_min,
      hid('BK', Math.max(0, t.trips_min - p.yday)), hid('EARN', p.fares), hid('BK', p.before), p.before_days]);
  }

  /* ── Action list ────────────────────────────────────────────────────── */
  const s5 = wb.sheet('Action list', { widths: [10, 13, 10, 16, 48, 60, 48, 13, 11, 17] });
  let findings = null;
  if (hide.has('ID')) {
    s5.text('Withheld: the findings name drivers, and your role does not hold driver identity in full.', 'wrap');
  } else {
    const rows = await q(insightListSql(5000), [null, null, null, null, null, null, null]);
    findings = rows.length;
    s5.text(`${rows.length} open finding${rows.length === 1 ? '' : 's'}, most severe first — the Action list’s own list.`, 'dim');
    s5.header(['Severity', 'Category', 'Fleet', 'About', 'Finding', 'Detail', 'What to do', 'Cost (AED)', 'Cost is', 'Computed'],
      ['text', 'text', 'text', 'text', 'wrap', 'wrap', 'wrap', 'money', 'text', 'datetime']);
    for (const r of rows) {
      s5.row([r.severity, r.category, r.fleet_id, r.entity_id ? `${r.entity_type || ''} ${r.entity_id}`.trim() : null,
        r.title, r.detail, r.action, money(r.impact_aed == null ? null : Number(r.impact_aed)), r.impact_kind,
        r.computed_at ? dubaiStamp(r.computed_at) : null]);
    }
  }

  /* ── Today so far ───────────────────────────────────────────────────── */
  const s6 = wb.sheet('Today so far', { widths: [30, 18, 70] });
  const day = await buildDay(q, today).catch(() => null);
  const h = day?.headline || {};
  s6.text(`Today, ${shortDay(today)}, as of ${dubaiStamp(now).slice(11)} Dubai — both fleets, every channel.`, 'dim');
  s6.blank();
  const live = [
    ['Bookings', hid('BK', h.bookings ?? null), 'int', null],
    ['Completed', hid('BK', h.completed ?? null), 'int', null],
    ['Cancelled', hid('BK', h.not_completed ?? null), 'int', null],
    ['Trip value, estimated (AED)', money(h.expected_revenue ?? null), 'money',
      h.expected_revenue != null ? 'Bookings with no price yet valued at what a booking on the same channel was worth over the settled days behind them. Uber prices a day overnight.' : null],
    ['Fares on record (AED)', money(h.revenue ?? null), 'money', h.priced != null && h.bookings != null ? `On ${h.priced} of ${h.bookings} bookings priced so far.` : null],
    ['Money in (AED)', money(h.accounted ?? null), 'money', 'Fares where a channel publishes one, the platform’s statement or payout where it publishes that instead — not the target’s measure.'],
    ['Booked km', hid('BK', h.booked_km ?? null), 'int', null],
    ['Drivers out', h.drivers ?? null, 'int', null],
    ['Cars out', hid('VEH', h.vehicles ?? null), 'int', null],
    ['Latest booking', h.last_at ? dubaiStamp(h.last_at) : null, 'datetime', null],
    ['Today needs (AED)', money(t.summary?.today_needs ?? null), 'money', t.summary ? null : t.why],
  ];
  for (const [label, v, kind, note] of live) s6.push([[label, 'bold'], [v, kind], [note, 'dim']]);
  if (!day) s6.text('Today’s figures could not be read when this file was made.', 'wrap');

  const name = `today-${today}${t.summary ? `-target-${t.month}` : ''}.xlsx`;
  return { wb, name, month: t.month, drivers: ppl.length, cars: cars.length, findings };
}

/* 'YYYY-MM-DD HH:MM' in Dubai, which is what the writer turns into an Excel
   date (Excel has no time zone; every time in this product is Dubai's). */
function dubaiStamp(v) {
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + 4 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}
