/* THE MONEY WORKBOOK — cash to collect, and every figure behind it, for a range.
   ═════════════════════════════════════════════════════════════════════════
   Asked for on 2026-09-28: "download the combined money and bank payouts and
   cash on hand etc every detail, every platform as a downloadable excel file
   based on the range". The operator then settled who it is for and how:

     · a SUPERVISOR CHASING CASH is the reader, so the first sheet after the
       notes is one row per driver, the most to collect first, with the
       number to ring;
     · "not measurable is not acceptable" for cash on hand, so the figure
       chased is one this database can always state — the operator's own
       definition of cash taken (2026-09-22, api/register_routes.js):
           cash trip amounts + cash advances − cash handed in, over the dates.
       It is a flow over the chosen dates, and the file says so in words:
       cash taken before the first date is outside it, and choosing earlier
       dates brings it in. Nothing is guessed to make it a "balance";
     · anyone may download it ("it's operations"); a signed-in reader's file
       holds only the classes their role holds in full, as the trip CSV does;
     · plain numbers, no formulas.

   Every sheet is built from the tables the pages read, through the same
   definitions: trip_cash (sql/schema_v80.sql) for the cash on a trip — Uber's
   own cash-collected figure where its payments report has arrived, the fare
   otherwise; driver_ledger for hand-ins and advances, with its sign
   convention (a hand-in is stored negative, so it is ADDED, never
   subtracted twice); ALL_PAYOUTS and PAYOUT_PROVIDERS from
   api/payout_routes.js for the bank, so the file and #payouts cannot say two
   different things; the phone chosen exactly as the 05:00 text chooses it
   (src/driver_sms.js phoneFor), with the reason in words where it holds back.

   What cannot be put in a number is put in a sentence beside it, never as a
   nought: a cash trip the platform has not priced yet is COUNTED, in its own
   column, and named on the notes sheet with the reason; a platform whose
   latest collection failed is named there too. */
import { Workbook } from '../src/xlsx_write.js';
import { phoneFor, HOLD_WHY, loadPhoneBook } from '../src/driver_sms.js';
import { uaeMobile } from '../src/smsala.js';
import { ALL_PAYOUTS, PAYOUT_PROVIDERS } from './payout_routes.js';

/* Every trip is one row each on the Trips sheet up to this many days. A
   month of bookings is about 25,000 rows; a year would be 290,000 on the
   smallest instance, and the trip CSV (api/export_routes.js) already streams
   any length. Measured: 5,552 bookings in the seven days to 2026-09-28. */
export const EVERY_TRIP_MAX_DAYS = 31;
/* The longest range one workbook is built for. Every other sheet grows with
   the drivers and the days, not the trips, and a year is what a supervisor or
   an accountant asks for; past it the file is refused with the reason. */
export const MAX_DAYS = 366;

const PLATFORM = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel', fms: 'FMS' };
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const plat = (p) => PLATFORM[p] || p || '';
const fleetName = (f) => FLEET[f] || (f ? f[0].toUpperCase() + f.slice(1) : '');
const r2 = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const r1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const num = (n) => (n == null || n === '' ? null : Number(n));

/* The class of data each kind of column carries (api/public/access_model.js).
   A signed-in reader whose role does not hold a class IN FULL gets
   "(withheld)" in every such cell that had a value — never an empty cell,
   which would read as "nothing recorded". */
const WITHHELD = '(withheld)';
const CLASS_WORDS = { ID: 'who drivers are', CT: 'contact details', CASH: 'cash', REV: 'revenue',
  PAY: 'bank payouts', VEH: 'vehicles', BK: 'bookings' };

/* A driver's account, the way every page keys one: the platform id, or for a
   hotel driver with none, their name folded exactly as api/register_routes.js
   folds it (CANON) — a key built two ways would match nothing. */
const ACCT = (a) => `coalesce(nullif(btrim(${a}.driver_ext_id), ''), 'name:' || lower(regexp_replace(btrim(${a}.driver_name), '\\s+', ' ', 'g')))`;
/* Dubai days as a range on the stored instant, so the index on requested_at
   is used rather than a function of it computed for every row. */
const IN_DAYS = (a) => `${a}.requested_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai')
  AND ${a}.requested_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;
const FILTERS = (a) => `($3::text IS NULL OR ${a}.fleet_id = $3) AND ($4::text IS NULL OR ${a}.platform = $4)
  AND ($5::text[] IS NULL OR (${a}.platform || ':' || ${ACCT(a)}) = ANY($5) OR ('*:' || ${ACCT(a)}) = ANY($5))`;
const DUBAI_AT = (col) => `to_char((${col}) AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI')`;
const DUBAI_DAY = (col) => `to_char((${col}) AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD')`;

/* '971501234567' → '+971 50 123 4567', which is how a supervisor dials it. */
export const dialFormat = (n) => (/^9715\d{8}$/.test(String(n || ''))
  ? `+971 ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}` : (n || ''));

/* The mobile beside a driver, and what to know about it. The 05:00 text
   holds back on any doubt; a supervisor RINGING can use a number the text
   would not, as long as the doubt is written next to it. */
function mobileFor(book, person) {
  const ph = phoneFor(book, person);
  if (ph.phone) return { mobile: dialFormat(ph.phone), note: ph.source === 'hr' ? 'HR’s number (Uber has none)' : 'Uber’s number' };
  const key = String(person);
  const all = [...new Set([...(book.uberNums.get(key) || []), ...(book.hrNums.get(key) || [])])];
  return { mobile: all.map(dialFormat).join(' / '), note: HOLD_WHY[ph.hold] || ph.hold || '' };
}

/**
 * Build the workbook.
 * @param q        (sql, params) => rows
 * @param from,to  Dubai days, inclusive
 * @param fleet, platform  the page's chips, or null for all
 * @param person   { id, name } for one driver's file, or { account } for one
 *                 unplaced account, or null for everyone
 * @param hide     Set of access classes this reader does not hold in full
 * @param now      the moment the file is made (tests pin it)
 */
export async function buildMoneyWorkbook({ q, from, to, fleet = null, platform = null, person = null,
  hide = new Set(), now = new Date() }) {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
  const h = (cls, v) => (hide.has(cls) && v != null && v !== '' ? WITHHELD : v);

  /* One driver: their accounts, as "platform:id" keys the filters match. */
  let accts = null;
  if (person?.id != null) {
    const rows = await q(`SELECT platform, external_id FROM driver_platform_id
                           WHERE driver_id = $1 AND detached_at IS NULL`, [person.id]);
    accts = rows.map((r) => `${r.platform}:${r.external_id}`);
    if (!accts.length) accts = ['-:-'];
  } else if (person?.account) {
    accts = [`*:${person.account}`];
  }
  const P = [from, to, fleet, platform, accts];

  const [cashRows, ledgerRows, acctRows, byAcct, byDay, payouts, statements, runs, compliance, drivers] = await Promise.all([
    q(`SELECT tc.platform, tc.fleet_id, tc.external_id, ${ACCT('tc')} AS acct, tc.driver_ext_id, tc.driver_name, tc.plate,
              tc.fare, tc.cash_amount, tc.cash_basis,
              ${DUBAI_DAY('tc.requested_at')} AS day, ${DUBAI_AT('tc.requested_at')} AS at
         FROM trip_cash tc
        WHERE ${IN_DAYS('tc')} AND ${FILTERS('tc')}
        ORDER BY tc.requested_at, tc.external_id`, P),
    /* Hand-ins and advances. A hand-in is not per platform, so the platform
       chip does not narrow it; the notes sheet says so when one is set. */
    person?.account ? [] : q(`SELECT e.id::text AS id, e.person_id::text AS person, e.person_name, e.type_code, e.book,
              e.amount, to_char(e.effective_on, 'YYYY-MM-DD') AS day, e.entered_by, e.note,
              (e.receipt_sha IS NOT NULL) AS has_receipt, coalesce(ty.label, e.type_code) AS label
         FROM driver_ledger e
         JOIN driver d ON d.id = e.person_id
         LEFT JOIN ledger_type ty ON ty.code = e.type_code
        WHERE e.entry_source <> 'verification'
          AND e.effective_on BETWEEN $1::date AND $2::date
          AND ((e.book = 'cash' AND e.type_code <> 'cash_opening') OR e.type_code = 'cash_advance')
          AND ($3::text IS NULL OR d.fleet_id = $3)
          AND ($4::bigint IS NULL OR e.person_id = $4)
        ORDER BY e.effective_on, e.id`, [from, to, fleet, person?.id ?? null]),
    q(`SELECT platform, external_id, driver_id::text AS person FROM driver_platform_id
        WHERE detached_at IS NULL AND driver_id IS NOT NULL`),
    q(`SELECT n.platform, n.fleet_id, ${ACCT('n')} AS acct, max(n.driver_ext_id) AS driver_ext_id, max(n.driver_name) AS name,
              count(*)::int AS bookings,
              count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE n.has_fare)::int AS priced,
              sum(n.price) FILTER (WHERE n.has_fare) AS fares,
              sum(abs((n.raw -> 'uber_payments' ->> 'service_fee')::numeric)) AS commission,
              sum(n.distance_km) FILTER (WHERE n.has_distance) AS km,
              count(DISTINCT n.local_day)::int AS days
         FROM trip_norm n
        WHERE ${IN_DAYS('n')} AND n.is_booking AND ${FILTERS('n')}
        GROUP BY 1, 2, 3`, P),
    person ? [] : q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, coalesce(n.fleet_id, 'unassigned') AS fleet_id, n.platform,
              count(*)::int AS bookings,
              count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE n.has_fare)::int AS priced,
              sum(n.price) FILTER (WHERE n.has_fare) AS fares,
              sum(abs((n.raw -> 'uber_payments' ->> 'service_fee')::numeric)) AS commission,
              count(DISTINCT ${ACCT('n')})::int AS accounts
         FROM trip_norm n
        WHERE ${IN_DAYS('n')} AND n.is_booking AND ${FILTERS('n')}
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, P),
    person ? [] : q(`WITH ${ALL_PAYOUTS}
       SELECT platform, fleet_id, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, amount, currency,
              to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
              source, listed_by_provider, basis
         FROM allp
        WHERE paid_on BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR fleet_id = $3) AND ($4::text IS NULL OR platform = $4)
        ORDER BY paid_on, platform, fleet_id`, [from, to, fleet, platform]),
    person ? [] : q(`SELECT platform, fleet_id, to_char(day, 'YYYY-MM-DD') AS day, basis, currency,
              opening_balance, earnings, refunds_expenses, cash_collected, commission, tips, taxes,
              bank_transferred, closing_balance
         FROM platform_account_day
        WHERE day BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR fleet_id = $3) AND ($4::text IS NULL OR platform = $4)
        ORDER BY day, platform, fleet_id`, [from, to, fleet, platform]),
    q(`SELECT source, fleet_id,
              ${DUBAI_AT("max(finished_at) FILTER (WHERE status IN ('ok', 'partial'))")} AS last_ok,
              (array_agg(status ORDER BY started_at DESC))[1] AS latest_status,
              ${DUBAI_AT('max(started_at)')} AS latest_at
         FROM collection_run
        WHERE source IN ('uber', 'bolt', 'yango', 'hotel') AND fleet_id IS NOT NULL
        GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT platform, driver_ext_id, phone FROM driver_compliance
        WHERE phone IS NOT NULL AND btrim(phone) <> ''`),
    q(`SELECT id::text AS id, full_name, fleet_id FROM driver`),
  ]);
  const book = await loadPhoneBook(q);

  const personOf = new Map(acctRows.map((a) => [`${a.platform}:${a.external_id}`, a.person]));
  const driverRow = new Map(drivers.map((d) => [d.id, d]));
  const compPhone = new Map();
  for (const c of compliance) {
    const n = uaeMobile(c.phone);
    if (n && !compPhone.has(`${c.platform}:${c.driver_ext_id}`)) compPhone.set(`${c.platform}:${c.driver_ext_id}`, n);
  }

  /* ── one entry per person, or per account no person has been placed on ── */
  const who = new Map();
  const keyOf = (platformId, acct) => {
    const p = personOf.get(`${platformId}:${acct}`);
    return p ? `p${p}` : `a${platformId}:${acct}`;
  };
  const entry = (k, name, platformId, acct) => {
    if (!who.has(k)) {
      const pid = k.startsWith('p') ? k.slice(1) : null;
      const d = pid ? driverRow.get(pid) : null;
      who.set(k, { key: k, person: pid, name: d?.full_name || name || '(no name on the record)',
        placed: !!pid, platforms: new Set(), fleets: new Set(), accounts: new Set(),
        cashTrips: 0, cashTaken: 0, unpriced: 0, advanced: 0, handedIn: 0, lastCash: null, lastHandIn: null,
        bookings: 0, completed: 0, priced: 0, fares: 0, commission: 0, km: 0, daySet: new Set(), daysWorked: 0,
        faresBy: {}, acctPlatform: platformId, acct, homeFleet: d?.fleet_id || null });
    }
    const e = who.get(k);
    if (platformId) e.platforms.add(platformId);
    if (acct) e.accounts.add(`${platformId}:${acct}`);
    return e;
  };

  /* Cash per trip, per person, per day. */
  const byPersonDay = new Map();
  const unpricedBy = {};
  const basisBy = {};
  for (const t of cashRows) {
    const e = entry(keyOf(t.platform, t.acct), t.driver_name, t.platform, t.acct);
    if (t.fleet_id) e.fleets.add(t.fleet_id);
    e.cashTrips += 1;
    basisBy[t.platform] = basisBy[t.platform] || { payments_report: 0, fare_only: 0, unvalued: 0 };
    basisBy[t.platform][t.cash_basis] = (basisBy[t.platform][t.cash_basis] || 0) + 1;
    const pd = `${e.key}|${t.day}`;
    if (!byPersonDay.has(pd)) byPersonDay.set(pd, { e, day: t.day, trips: 0, cash: 0, unpriced: 0, advanced: 0, handedIn: 0 });
    const d = byPersonDay.get(pd);
    d.trips += 1;
    if (t.cash_amount == null) {
      e.unpriced += 1; d.unpriced += 1;
      unpricedBy[t.platform] = (unpricedBy[t.platform] || 0) + 1;
    } else {
      e.cashTaken += Number(t.cash_amount); d.cash += Number(t.cash_amount);
    }
    if (!e.lastCash || t.at > e.lastCash) e.lastCash = t.at;
    t.who = e;
  }
  /* Hand-ins (stored negative) and advances (stored positive). */
  for (const l of ledgerRows) {
    const e = entry(`p${l.person}`, l.person_name, null, null);
    if (e.homeFleet) e.fleets.add(e.homeFleet);
    const amt = Number(l.amount);
    const pd = `${e.key}|${l.day}`;
    if (!byPersonDay.has(pd)) byPersonDay.set(pd, { e, day: l.day, trips: 0, cash: 0, unpriced: 0, advanced: 0, handedIn: 0 });
    const d = byPersonDay.get(pd);
    if (l.type_code === 'cash_advance') { e.advanced += amt; d.advanced += amt; } else {
      e.handedIn += -amt; d.handedIn += -amt;
      if (!e.lastHandIn || l.day > e.lastHandIn) e.lastHandIn = l.day;
    }
    l.who = e;
  }
  /* Everything else each person did in the dates. */
  for (const a of byAcct) {
    const e = entry(keyOf(a.platform, a.acct), a.name, a.platform, a.acct);
    if (a.fleet_id) e.fleets.add(a.fleet_id);
    e.bookings += a.bookings; e.completed += a.completed; e.priced += a.priced;
    e.fares += Number(a.fares || 0); e.commission += Number(a.commission || 0); e.km += Number(a.km || 0);
    e.daysWorked = Math.max(e.daysWorked, a.days);
    /* Only a platform that priced something puts a figure in its column: a
       platform whose bookings carried no fare leaves the cell empty, never
       0.00 (the notes sheet and #provenance say which channels send none). */
    if (a.priced) e.faresBy[a.platform] = (e.faresBy[a.platform] || 0) + Number(a.fares || 0);
  }
  const everyone = [...who.values()];
  for (const e of everyone) e.toHandIn = r2(e.cashTaken + e.advanced - e.handedIn);

  const contact = (e) => {
    if (e.placed) return mobileFor(book, e.person);
    const n = compPhone.get(`${e.acctPlatform}:${e.acct}`);
    return { mobile: n ? dialFormat(n) : '',
      note: n ? 'From this account’s own record: the account is not yet placed on a person.'
        : 'No mobile on this account’s record, and the account is not yet placed on a person.' };
  };
  const nameOf = (e) => (e.placed ? e.name : `${e.name} (${plat(e.acctPlatform)} account, not yet placed on a person)`);
  const fleetsOf = (e) => [...(e.fleets.size ? e.fleets : new Set(e.homeFleet ? [e.homeFleet] : []))].map(fleetName).join(' & ');
  const platsOf = (e) => [...e.platforms].map(plat).join(', ');

  const wb = new Workbook({ created: now });
  const nowDubai = new Date(now.getTime() + 4 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const scopeWords = fleet ? fleetName(fleet) : 'Ecosine & Egari';
  const cashPeople = everyone.filter((e) => e.cashTrips || e.advanced || e.handedIn)
    .sort((a, b) => (b.toHandIn - a.toHandIn) || a.name.localeCompare(b.name));
  const sum = (arr, f) => r2(arr.reduce((acc, x) => acc + (Number(f(x)) || 0), 0));
  const tot = {
    people: cashPeople.length,
    taken: sum(cashPeople, (e) => e.cashTaken), advanced: sum(cashPeople, (e) => e.advanced),
    handedIn: sum(cashPeople, (e) => e.handedIn), toHandIn: sum(cashPeople, (e) => e.toHandIn),
    trips: cashRows.length, unpriced: cashRows.filter((t) => t.cash_amount == null).length,
    handIns: ledgerRows.filter((l) => l.type_code !== 'cash_advance').length,
  };
  const everyTrip = !!person || days <= EVERY_TRIP_MAX_DAYS;

  /* ── Read me ─────────────────────────────────────────────────────────── */
  const rm = wb.sheet('Read me', { widths: [34, 110] });
  rm.text(`Cash and money — ${person ? (person.name || person.account) : scopeWords} — ${from} to ${to}`, 'title');
  rm.pair('Made', nowDubai, 'datetime');
  rm.pair('Dates', `${from} to ${to} (${days} day${days === 1 ? '' : 's'}). Every date and time in this file is Dubai time.`);
  rm.pair('Fleets', fleet ? fleetName(fleet) : 'Both — Ecosine and Egari');
  rm.pair('Platforms', platform ? plat(platform) : 'All — Uber, Bolt, Yango and Hotel');
  if (person) rm.pair('Driver', person.name || person.account);
  rm.blank();
  rm.text('Start here', 'bold');
  rm.text('“Cash to collect” lists every driver who took cash in these dates, the most to collect first, with the mobile to ring. '
    + 'Use the filter arrows on its header to show one fleet or one platform.');
  rm.blank();
  rm.text('Summary', 'bold');
  rm.pair('Drivers with cash in these dates', tot.people, 'int');
  rm.pair('Cash from trips (AED)', h('CASH', tot.taken), 'money');
  rm.pair('Cash advanced (AED)', h('CASH', tot.advanced), 'money');
  rm.pair('Cash handed in (AED)', h('CASH', tot.handedIn), 'money');
  rm.push([['To hand in (AED)', 'bold'], [h('CASH', tot.toHandIn), 'moneyBold']]);
  rm.pair('Cash trips', tot.trips, 'int');
  rm.pair('…of which not priced yet', tot.unpriced, 'int');
  rm.blank();
  rm.text('How “To hand in” is worked out', 'bold');
  rm.text('To hand in = cash from trips + cash advanced − cash handed in, over these dates only. '
    + 'It is the operator’s own definition of cash taken (22 September 2026).');
  rm.text('Cash from a trip is the platform’s own cash-collected figure where it has sent one — Uber, once its nightly catch-up '
    + 'has read the payments report; it includes the booking fee and the tolls the rider paid, so it is higher than the fare — '
    + 'and the fare otherwise.');
  rm.text(tot.handIns
    ? `${tot.handIns} hand-in${tot.handIns === 1 ? ' is' : 's are'} recorded in FleetMirror for these dates and subtracted.`
    : 'No cash hand-in is recorded in FleetMirror for these dates, so “To hand in” is all the cash taken. '
      + 'Record each hand-in on Money → Cash handed in; the next download subtracts it.');
  rm.text(`Cash a driver took before ${from} is not in these figures. Choose earlier dates to include it.`);
  if (platform) rm.text(`Only ${plat(platform)} trips are counted. A hand-in is not per platform, so every hand-in in these dates is subtracted in full.`);
  for (const [p, n] of Object.entries(unpricedBy).sort()) {
    rm.text(`${plat(p)}: ${n.toLocaleString('en')} cash trip${n === 1 ? ' has' : 's have'} no amount yet — `
      + (p === 'uber'
        ? 'Uber prices a trip only when its nightly catch-up (01:00 Dubai) or the Sunday backfill reads the payments report, so the latest days fill in overnight.'
        : `${plat(p)} sent no fare for ${n === 1 ? 'it' : 'them'}.`)
      + ' They are counted under “Not priced yet” and are in no amount.');
  }
  if (!person) {
    rm.blank();
    rm.text('Bank payouts', 'bold');
    rm.text('Listed by the day the money ARRIVED in the bank. An Uber wire pays for the Monday-to-Sunday week before it, shown beside it; '
      + 'Bolt does not say which days a payout covers. So the payouts in a range are not the money earned in it — '
      + 'the last week of a range is paid after it ends.');
    for (const prov of PAYOUT_PROVIDERS.filter((x) => !platform || x.platform === platform)) {
      const said = prov.publishes ? [prov.how, prov.cadence].filter(Boolean).join(' ') : prov.why_absent;
      rm.pair(plat(prov.platform), said);
    }
    if (!platform || platform === 'hotel') rm.pair('Hotel', 'No transfer from the hotel channel is collected by FleetMirror.');
  }
  rm.blank();
  rm.text('Is every platform in?', 'bold');
  const livePairs = new Set(byAcct.map((a) => `${a.platform}:${a.fleet_id}`));
  for (const r of runs.filter((x) => (!fleet || x.fleet_id === fleet) && (!platform || x.source === platform))) {
    const ok = ['ok', 'partial'].includes(r.latest_status);
    rm.pair(`${plat(r.source)} — ${fleetName(r.fleet_id)}`, ok
      ? `Collecting: last good collection ${r.last_ok}.`
      : `The latest collection (${r.latest_at}) FAILED; the last good one was ${r.last_ok || 'never'}. `
        + `${plat(r.source)} trips for ${fleetName(r.fleet_id)} after that may be missing from every figure here.`);
  }
  if (!livePairs.size && !cashRows.length) rm.text('No booking is on record for these dates and filters.');
  rm.blank();
  rm.text('The sheets', 'bold');
  const guide = [
    ['Cash to collect', 'One row per driver: cash from trips, advanced, handed in, and to hand in, with the mobile.'],
    ['Cash by day', 'The same, per driver per day, with a running total to hand in across the dates.'],
    ['Cash trips', 'Every trip on which a driver took cash: when, which car, how much, and how the amount was valued.'],
    ['Hand-ins & advances', 'Every cash hand-in and cash advance recorded in FleetMirror in these dates.'],
    ...(person ? [] : [
      ['Drivers', 'Every driver who worked in these dates: bookings, fares by platform, cash, commission, km.'],
      ['Money by day', 'Per day, fleet and platform: bookings, fares, cash taken, commission.'],
      ['Bank payouts', 'Every transfer a platform made to the company’s bank in these dates.'],
      ['Platform statements', 'Each platform’s own daily account figures, where it publishes them.'],
    ]),
    ...(everyTrip ? [['Every trip', 'One row per booking, cash or not.']] : []),
  ];
  for (const [s, what] of guide) rm.pair(s, what);
  if (!everyTrip) {
    rm.text(`“Every trip” is included for ranges up to ${EVERY_TRIP_MAX_DAYS} days; this range is ${days}. `
      + 'For every booking over a longer range use the “every trip” CSV download on the Overview page.');
  }
  if (hide.size) {
    rm.blank();
    rm.text(`Cells reading ${WITHHELD} held a value your role does not include: ${[...hide].map((c) => CLASS_WORDS[c] || c).join(', ')}. `
      + 'An empty cell never had one.', 'bold');
  }

  /* ── Cash to collect ─────────────────────────────────────────────────── */
  const cc = wb.sheet('Cash to collect', { widths: [34, 16, 20, 44, 20, 11, 16, 14, 14, 16, 12, 18, 14] });
  cc.header(['Driver', 'Fleet', 'Mobile', 'About the mobile', 'Platforms', 'Cash trips', 'Cash from trips (AED)',
    'Cash advanced (AED)', 'Handed in (AED)', 'To hand in (AED)', 'Not priced yet', 'Last cash trip', 'Last hand-in'],
  ['text', 'text', 'text', 'wrap', 'text', 'int', 'money', 'money', 'money', 'money', 'int', 'datetime', 'date']);
  for (const e of cashPeople) {
    const c = contact(e);
    cc.row([h('ID', nameOf(e)), fleetsOf(e), h('CT', c.mobile), h('CT', c.note), platsOf(e), e.cashTrips,
      h('CASH', r2(e.cashTaken)), h('CASH', r2(e.advanced)), h('CASH', r2(e.handedIn)), h('CASH', e.toHandIn),
      e.unpriced, e.lastCash, e.lastHandIn]);
  }
  if (!cashPeople.length) cc.text('No driver took cash, was advanced cash or handed any in during these dates.', 'dim');

  /* ── Cash by day ─────────────────────────────────────────────────────── */
  const cd = wb.sheet('Cash by day', { widths: [12, 34, 16, 11, 16, 14, 14, 16, 18, 12] });
  cd.header(['Day', 'Driver', 'Fleet', 'Cash trips', 'Cash from trips (AED)', 'Cash advanced (AED)', 'Handed in (AED)',
    'To hand in that day (AED)', 'To hand in so far (AED)', 'Not priced yet'],
  ['date', 'text', 'text', 'int', 'money', 'money', 'money', 'money', 'money', 'int']);
  const pdRows = [...byPersonDay.values()].sort((a, b) => a.e.name.localeCompare(b.e.name) || a.e.key.localeCompare(b.e.key) || a.day.localeCompare(b.day));
  const running = new Map();
  for (const d of pdRows) {
    const net = d.cash + d.advanced - d.handedIn;
    running.set(d.e.key, (running.get(d.e.key) || 0) + net);
    cd.row([d.day, h('ID', nameOf(d.e)), fleetsOf(d.e), d.trips, h('CASH', r2(d.cash)), h('CASH', r2(d.advanced)),
      h('CASH', r2(d.handedIn)), h('CASH', r2(net)), h('CASH', r2(running.get(d.e.key))), d.unpriced]);
  }

  /* ── Cash trips ──────────────────────────────────────────────────────── */
  const ct = wb.sheet('Cash trips', { widths: [17, 34, 10, 12, 12, 14, 26, 14, 22] });
  ct.header(['When', 'Driver', 'Platform', 'Fleet', 'Car', 'Cash (AED)', 'How the cash was valued', 'Fare (AED)', 'Trip id'],
    ['datetime', 'text', 'text', 'text', 'text', 'money', 'text', 'money', 'text']);
  const HOW = { payments_report: 'the platform’s cash-collected figure', fare_only: 'the fare', unvalued: 'not priced yet' };
  for (const t of cashRows) {
    ct.row([t.at, h('ID', nameOf(t.who)), plat(t.platform), fleetName(t.fleet_id), h('VEH', t.plate),
      h('CASH', r2(t.cash_amount)), HOW[t.cash_basis] || t.cash_basis, h('REV', r2(t.fare)), t.external_id]);
  }

  /* ── Hand-ins & advances ─────────────────────────────────────────────── */
  const hi = wb.sheet('Hand-ins & advances', { widths: [12, 34, 18, 14, 26, 40, 10, 10] });
  hi.header(['Day', 'Driver', 'What', 'Amount (AED)', 'Recorded by', 'Note', 'Receipt', 'Entry'],
    ['date', 'text', 'text', 'money', 'text', 'wrap', 'text', 'text']);
  for (const l of ledgerRows) {
    hi.row([l.day, h('ID', nameOf(l.who)), l.label, h('CASH', r2(Math.abs(Number(l.amount)))), l.entered_by || '',
      l.note || '', l.has_receipt ? 'photo held' : 'none', l.id]);
  }
  if (!ledgerRows.length) hi.text('Nothing recorded in these dates. Hand-ins are recorded on Money → Cash handed in.', 'dim');

  if (!person) {
    /* ── Drivers ───────────────────────────────────────────────────────── */
    const dr = wb.sheet('Drivers', { widths: [34, 16, 20, 10, 10, 14, 13, 13, 13, 13, 14, 14, 10, 9] });
    const PL = ['uber', 'bolt', 'yango', 'hotel'].filter((p) => !platform || p === platform);
    dr.header(['Driver', 'Fleet', 'Platforms', 'Bookings', 'Completed', 'Fares (AED)',
      ...PL.map((p) => `${plat(p)} fares (AED)`), 'Cash trips', 'Cash from trips (AED)', 'Uber commission (AED)', 'Km', 'Days worked'],
    ['text', 'text', 'text', 'int', 'int', 'money', ...PL.map(() => 'money'), 'int', 'money', 'money', 'num1', 'int']);
    const worked = everyone.filter((e) => e.bookings).sort((a, b) => (b.fares - a.fares) || a.name.localeCompare(b.name));
    for (const e of worked) {
      dr.row([h('ID', nameOf(e)), fleetsOf(e), platsOf(e), e.bookings, e.completed, h('REV', e.priced ? r2(e.fares) : null),
        ...PL.map((p) => h('REV', e.faresBy[p] == null ? null : r2(e.faresBy[p]))), e.cashTrips, h('CASH', r2(e.cashTaken)),
        h('REV', e.commission ? r2(e.commission) : null), r1(e.km), e.daysWorked]);
    }

    /* ── Money by day ──────────────────────────────────────────────────── */
    const md = wb.sheet('Money by day', { widths: [12, 12, 10, 10, 10, 14, 14, 11, 14, 16] });
    md.header(['Day', 'Fleet', 'Platform', 'Bookings', 'Completed', 'Fares (AED)', 'Cash taken (AED)', 'Cash trips',
      'Not priced yet', 'Uber commission (AED)'],
    ['date', 'text', 'text', 'int', 'int', 'money', 'money', 'int', 'int', 'money']);
    const cashDay = new Map();
    for (const t of cashRows) {
      const k = `${t.day}|${t.fleet_id || 'unassigned'}|${t.platform}`;
      if (!cashDay.has(k)) cashDay.set(k, { cash: 0, trips: 0, unpriced: 0 });
      const c = cashDay.get(k);
      c.trips += 1;
      if (t.cash_amount == null) c.unpriced += 1; else c.cash += Number(t.cash_amount);
    }
    for (const d of byDay) {
      const c = cashDay.get(`${d.day}|${d.fleet_id}|${d.platform}`) || { cash: 0, trips: 0, unpriced: 0 };
      md.row([d.day, fleetName(d.fleet_id), plat(d.platform), d.bookings, d.completed,
        h('REV', d.priced ? r2(d.fares) : null), h('CASH', r2(c.cash)), c.trips, c.unpriced,
        h('REV', d.commission ? r2(d.commission) : null)]);
    }

    /* ── Bank payouts ──────────────────────────────────────────────────── */
    const bp = wb.sheet('Bank payouts', { widths: [12, 10, 12, 16, 14, 14, 44, 40] });
    bp.header(['Arrived', 'Platform', 'Fleet', 'Amount (AED)', 'Pays for, from', 'Pays for, to', 'Listed by the platform', 'Read from'],
      ['date', 'text', 'text', 'money', 'date', 'date', 'wrap', 'text']);
    for (const p of payouts) {
      bp.row([p.paid_on, plat(p.platform), fleetName(p.fleet_id), h('PAY', r2(p.amount)),
        p.period_start || (p.platform === 'bolt' ? 'Bolt does not say' : null), p.period_end,
        p.listed_by_provider ? 'yes' : 'not yet — read off Bolt’s balance ledger on the day it left; the list runs days behind',
        p.source || '']);
    }
    if (!payouts.length) bp.text('No transfer arrived in these dates. See “Bank payouts” on the Read me sheet for what each platform publishes.', 'dim');

    /* ── Platform statements ───────────────────────────────────────────── */
    const ps = wb.sheet('Platform statements', { widths: [12, 10, 12, 12, 14, 14, 14, 14, 14, 12, 12, 16, 14] });
    ps.header(['Day', 'Platform', 'Fleet', 'From', 'Opening (AED)', 'Earnings (AED)', 'Refunds & expenses (AED)',
      'Cash collected (AED)', 'Commission (AED)', 'Tips (AED)', 'Taxes (AED)', 'To the bank (AED)', 'Closing (AED)'],
    ['date', 'text', 'text', 'text', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money']);
    for (const s of statements) {
      ps.row([s.day, plat(s.platform), fleetName(s.fleet_id),
        s.basis === 'statement' ? 'the platform’s statement' : 'summed from the platform’s dated rows',
        ...['opening_balance', 'earnings', 'refunds_expenses', 'cash_collected', 'commission', 'tips', 'taxes',
          'bank_transferred', 'closing_balance'].map((k) => h(k === 'bank_transferred' ? 'PAY' : 'REV', r2(num(s[k]))))]);
    }
    if (!statements.length) ps.text('No platform published a daily account statement for these dates and filters.', 'dim');
  }

  /* ── Every trip ──────────────────────────────────────────────────────── */
  if (everyTrip) {
    const trips = await q(
      `SELECT ${DUBAI_AT('n.requested_at')} AS at, n.platform, n.fleet_id, n.driver_name, n.driver_ext_id, ${ACCT('n')} AS acct,
              n.plate, n.product, n.payment_type, n.outcome, n.price, n.has_fare, n.distance_km, n.external_id,
              tc.cash_amount, tc.cash_basis
         FROM trip_norm n
         LEFT JOIN trip_cash tc ON tc.platform = n.platform AND tc.external_id = n.external_id
        WHERE ${IN_DAYS('n')} AND n.is_booking AND ${FILTERS('n')}
        ORDER BY n.requested_at, n.external_id`, P);
    const et = wb.sheet('Every trip', { widths: [17, 34, 10, 12, 12, 16, 16, 14, 13, 13, 9, 22] });
    et.header(['When', 'Driver', 'Platform', 'Fleet', 'Car', 'Product', 'Payment', 'Outcome', 'Fare (AED)',
      'Cash taken (AED)', 'Km', 'Trip id'],
    ['datetime', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'money', 'money', 'num1', 'text']);
    for (const t of trips) {
      const e = who.get(keyOf(t.platform, t.acct));
      et.row([t.at, h('ID', e ? nameOf(e) : t.driver_name), plat(t.platform), fleetName(t.fleet_id), h('VEH', t.plate),
        t.product || '', t.payment_type || '', t.outcome || '', h('REV', t.has_fare ? r2(t.price) : null),
        h('CASH', r2(t.cash_amount)), r1(t.distance_km), t.external_id]);
    }
  }

  return { wb, days, totals: tot, sheets: wb.sheets.map((s) => s.name), unpricedBy, basisBy };
}
