/* The to-do list: what operations should do this month to earn more.
   ──────────────────────────────────────────────────────────────────────────
   Every other page here answers a question. This one proposes an action, which
   is a much stronger claim and needs a much stricter contract. Four rules, and
   each exists because breaking it produces a plausible instruction that wastes
   somebody's week:

   1. EVERY ACTION CARRIES ITS OWN ARITHMETIC. `basis` says in words how the
      size was computed, from which rows. An action nobody can check is an
      opinion with a database behind it.

   2. MEASURED AND MODELLED MONEY NEVER MIX. The Uber export has no fare
      column, so most of this fleet's volume cannot be priced at all. Actions
      touching it report trips, and convert to AED only when the caller
      supplies a rate — reported separately, beside the rate that produced it.

   3. THE SIZE IS THE CEILING, NOT THE EXPECTATION. "Nine idle vehicles at the
      fleet's median output" is what they would earn if every one were
      redeployed and matched the median. Both are optimistic. The field is
      named `ceiling` so nothing downstream reads it as a promise.

   4. AN ACTION WITH NOTHING BEHIND IT IS NOT SHOWN. A zero is not a to-do. */
import { custodyLatest, custodyOverWindow, custodyCountOverWindow, peopleCount, peopleCountStored, JOIN_TRIP } from './custody_sql.js';

export function playbookRoutes(app, { q, wrap, range, DAYWIN }) {
  app.get('/api/playbook', wrap(async (req, res) => {
    /* The platform and fleet chips were read and thrown away: every query below
       bound only [from, to], so the md5 of /api/playbook was IDENTICAL with no
       filter, &platform=bolt, &platform=uber, &fleet=egari and &fleet=ecosine.
       On a two-fleet operator that means the Egari playbook proposed actions
       sized on Ecosine's cars.

       Where each dimension applies is not uniform, and pretending it is would
       be its own lie:
         PF    — trip-shaped rows, where both a channel and a fleet exist.
         FLEET — the vehicle universe and vehicle documents. A car belongs to a
                 fleet; it does not belong to a booking channel, and
                 vehicle_document.platform is the SOURCE that reported the
                 document ('fms'), never a channel — filtering documents by
                 platform=uber would empty the only loss-avoidance action on
                 the page while the documents were still expiring. */
    const p = range(req);
    const [from, to] = p;
    const PF = (alias = '') => {
      const c = alias ? `${alias}.` : '';
      return `AND ($3::text IS NULL OR ${c}platform=$3) AND ($4::text IS NULL OR ${c}fleet_id=$4)`;
    };
    const FLEET = (alias = '', bind = '$4') => {
      const c = alias ? `${alias}.` : '';
      return `AND (${bind}::text IS NULL OR ${c}fleet_id=${bind})`;
    };
    /* The operator's own revenue-per-booking assumption. Null by default and
       deliberately so: this fleet's only measured rate comes from the hotel
       channel, which is corporate limousine work, and applying it to UberX
       would invent about half a business. */
    const rate = Number(req.query.aed_per_trip) > 0 ? Number(req.query.aed_per_trip) : null;

    const [
      [fleet], idle, blocked, thinSlots, [recv], [cash], expiring, [cancel], strand, [licence],
      recvRows, cashRows, cancelRows,
    ] = await Promise.all([
      /* The reference numbers every size below is expressed against.

         The vehicle universe is the same union the vehicles directory uses —
         every plate that has ever appeared in a trip, a telemetry fix or a
         document. Counting only plates seen in THIS window reported 93
         vehicles where the directory reported 131, which understates idle
         capacity by exactly the vehicles that are most idle: a car that
         produced nothing and did not even move is invisible to a query
         scoped to the window's own rows. */
      q(`WITH plates AS (
           SELECT DISTINCT plate FROM (
             SELECT plate FROM trip WHERE plate IS NOT NULL AND plate <> '' ${FLEET()}
             UNION SELECT plate FROM telemetry_snapshot WHERE true ${FLEET()}
             UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL ${FLEET()}
           ) s
         ),
         v AS (
           SELECT p.plate,
                  count(t.*) FILTER (WHERE t.is_booking)::int bookings,
                  count(t.*) FILTER (WHERE NOT t.is_booking)::int journeys
           FROM plates p
           LEFT JOIN trip_norm t ON t.plate = p.plate AND ${DAYWIN('t.requested_at')} ${PF('t')}
           GROUP BY 1)
         SELECT count(*)::int vehicles_seen,
                count(*) FILTER (WHERE bookings > 0)::int earning,
                count(*) FILTER (WHERE bookings = 0 AND journeys > 0)::int moved_only,
                count(*) FILTER (WHERE bookings = 0 AND journeys = 0)::int still,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY bookings)
                  FILTER (WHERE bookings > 0) AS median_bookings
          FROM v`, p),

      // Vehicles on the books that took no booking in the window.
      q(`WITH plates AS (
           SELECT DISTINCT plate FROM (
             SELECT plate FROM trip WHERE plate IS NOT NULL AND plate <> '' ${FLEET()}
             UNION SELECT plate FROM telemetry_snapshot WHERE true ${FLEET()}
             UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL ${FLEET()}
           ) s
         ),
         /* "veh", not "v" — and the rename is the whole fix.
            custodyOverWindow and custodyCountOverWindow alias
            vehicle_driver_day as "v" (api/custody_sql.js:59,70). With the CTE
            also called "v", the injected predicate "v.plate = v.plate" bound
            BOTH sides to the inner table: a self-comparison that is true for
            every custody row in the window. So every idle-vehicle detail row
            came back with the same three drivers and the same driver_n — 123
            on all twelve rows in production, including L12377, L19261 and
            L25379, which have journeys 0 and no custody at all. The page named
            real people beside a car they had never held. */
         veh AS (
           SELECT p.plate,
                  count(t.*) FILTER (WHERE t.is_booking)::int bookings,
                  count(t.*) FILTER (WHERE NOT t.is_booking)::int journeys,
                  max(t.local_day) FILTER (WHERE t.is_booking) AS last_booking
           FROM plates p
           LEFT JOIN trip_norm t ON t.plate = p.plate AND ${DAYWIN('t.requested_at')} ${PF('t')}
           GROUP BY 1)
         SELECT plate, bookings, journeys, to_char(last_booking,'YYYY-MM-DD') AS last_booking,
                ${custodyOverWindow('veh.plate')} AS driver_refs,
                ${custodyCountOverWindow('veh.plate')} AS driver_n,
                /* The last person to hold this car at all, with the day —
                   because redeploying it is a phone call, and after the alias
                   fix above a car nobody held IN THE WINDOW correctly returns
                   no custodians, which leaves nobody to ring. The expiring
                   documents action already carries this field for exactly the
                   same reason. NULL where the car has genuinely never been
                   held, which is itself the finding. */
                ${custodyLatest('veh.plate')} AS held_by
          FROM veh WHERE bookings = 0 ORDER BY journeys DESC, plate LIMIT 200`, p),

      /* Somebody who cannot earn on any platform, holding a car. The vehicle
         is the fleet's constraint, not the person, so this is the cheapest
         capacity in the business to recover. */
      q(`SELECT s.full_name, s.driver_ext_id, s.plate, s.platform, s.state, s.state_reason
         FROM driver_platform_state s
         WHERE s.plate IS NOT NULL AND s.state IN ('suspended','deactivated')
           AND ($1::text IS NULL OR s.platform=$1) AND ($2::text IS NULL OR s.fleet_id=$2)
         ORDER BY s.full_name LIMIT 200`, [p[2], p[3]]),

      /* Hours where work reliably turns up and almost nobody covers it. Both
         halves matter: a thin hour with no demand is correctly unstaffed. */
      q(`WITH s AS (
           -- "hour" is a reserved word; unquoted as an alias it is a syntax
           -- error rather than a column name.
           SELECT n.local_dow AS dow, n.local_hour AS slot_hour,
                  count(*)::int trips,
                  count(DISTINCT n.local_day)::int days_seen,
                  ${peopleCountStored()}::int drivers
           FROM trip_norm n ${JOIN_TRIP}
           WHERE n.is_booking AND ${DAYWIN('n.requested_at')} ${PF('n')}
           GROUP BY 1,2)
         SELECT dow, slot_hour AS hour, trips, days_seen, drivers,
                round(trips::numeric / nullif(days_seen,0), 1) AS trips_per_occurrence
          FROM s
          WHERE drivers <= 3 AND days_seen >= 3 AND trips >= 20
          ORDER BY trips DESC LIMIT 20`, p),

      // Money already earned and not collected. Measured — these channels price.
      q(`SELECT count(*)::int trips,
                count(*) FILTER (WHERE price IS NOT NULL)::int priced,
                round(sum(price)::numeric,0) AS amount,
                /* Attributed the way #settlement/receivables attributes it — the page this
                   action links to. Coalescing partner-first folded every driver's salary
                   deduction into their employer, so the card said 6 counterparties and the
                   evidence page it opens said 11, over the very same AED 37,881. A salary
                   deduction is owed by the person it comes out of. */
                count(DISTINCT CASE WHEN settlement_class = 'salary' THEN coalesce(driver_name, '(unnamed driver)')
                     ELSE coalesce(partner_name, partner_id, '(unnamed property)') END)::int counterparties,
                max((now()::date - local_day))::int AS oldest_days
         FROM trip_ext WHERE ${DAYWIN('requested_at')} AND is_receivable ${PF()}`, p),

      // Cash a driver is personally holding at the end of a shift.
      q(`SELECT count(*)::int trips,
                count(*) FILTER (WHERE price IS NOT NULL)::int priced,
                round(sum(price)::numeric,0) AS amount,
                count(DISTINCT coalesce(driver_ext_id, driver_name))::int drivers
         FROM trip_ext WHERE ${DAYWIN('requested_at')} AND driver_holds_cash ${PF()}`, p),

      /* A document expiring is a vehicle that stops being able to work. This
         is the only lever here whose effect is avoiding a loss rather than
         making a gain, and it is the most certain of them. */
      q(`SELECT plate, doc_type, to_char(expires_at::date,'YYYY-MM-DD') AS expires_at,
                (expires_at::date - now()::date)::int AS days_left,
                /* Whoever is driving it now, with the day that reading comes
                   from. A renewal is a phone call and this is who answers it;
                   without the day, "held by Kashif" from eleven weeks ago
                   reads exactly like "held by Kashif" from yesterday. */
                ${custodyLatest('d.plate')} AS held_by
         FROM vehicle_document d
         WHERE expires_at IS NOT NULL AND expires_at::date <= now()::date + 45
           /* Fleet only. A document is reported BY a source ('fms'), not by a
              booking channel, so a platform predicate here would empty the
              page's only loss-avoidance action while the cars kept expiring. */
           AND ($1::text IS NULL OR d.fleet_id=$1)
         ORDER BY expires_at LIMIT 100`, [p[3]]),

      // Bookings lost at the door.
      q(`SELECT count(*) FILTER (WHERE outcome='not_completed')::int lost,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int judged,
                round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                      /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) AS pct
         FROM trip_norm WHERE is_booking AND ${DAYWIN('requested_at')} ${PF()}`, p),

      // Drop-off areas that leave a driver furthest from the next job.
      q(`SELECT coalesce(nullif(btrim(split_part(dropoff_addr, ',', 1)), ''), '(no address)') AS place,
                count(*)::int drops,
                round(avg(return_deadhead_km)::numeric,1) AS avg_return_km,
                round(sum(return_deadhead_km)::numeric,0) AS return_km
         FROM trip_ext
         WHERE ${DAYWIN('requested_at')} AND return_deadhead_km IS NOT NULL ${PF()}
         GROUP BY 1 HAVING count(*) >= 5
         ORDER BY sum(return_deadhead_km) DESC LIMIT 10`, p),

      q(`SELECT count(*)::int expiring
         FROM driver_compliance
         WHERE licence_expires IS NOT NULL
           AND licence_expires BETWEEN now()::date AND now()::date + 45
           AND ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR fleet_id=$2)`,
        [p[2], p[3]]),

      /* ── the evidence the three money actions were missing ─────────────
         Four of the seven actions carried 8-12 detail rows and expanded into a
         table. These three carried no `detail` key at all — including the two
         naming the largest MEASURED sums on the page (AED 38,595 across six
         counterparties, and cash held by 119 drivers). An action a reader
         cannot open is an instruction they have to take on faith, on the one
         page in this product that proposes doing something.

         Each row carries the id its entity page is keyed on, so the front
         end's RENDER map can link a counterparty and a driver rather than
         printing a name. */
      q(`SELECT CASE WHEN settlement_class = 'salary' THEN coalesce(driver_name, '(unnamed driver)')
                     ELSE coalesce(partner_name, partner_id, '(unnamed property)') END AS counterparty,
                max(partner_id) AS partner_id, max(driver_ext_id) AS driver_ext_id,
                max(settlement_class) AS settlement_class,
                count(*)::int trips,
                count(*) FILTER (WHERE price IS NOT NULL)::int priced,
                round(sum(price)::numeric,0) AS amount,
                max((now()::date - local_day))::int AS oldest_days
         FROM trip_ext WHERE ${DAYWIN('requested_at')} AND is_receivable ${PF()}
         GROUP BY 1 ORDER BY sum(price) DESC NULLS LAST LIMIT 12`, p),

      q(`SELECT coalesce(driver_name, '(unnamed)') AS driver, max(driver_ext_id) AS driver_ext_id,
                /* Which cars the money was taken in. A cash-handling control is
                   applied to a person, but the reconciliation is done against
                   a shift in a vehicle, and a driver row with no plate on it is
                   a dead end on a page full of links. */
                array_remove(array_agg(DISTINCT plate), NULL) AS plates,
                count(*)::int trips,
                count(*) FILTER (WHERE price IS NOT NULL)::int priced,
                round(sum(price)::numeric,0) AS amount,
                /* True when this driver's cash bookings come from a channel
                   that reports no fare — the AED beside them is then a floor
                   over the priced minority, not their takings. */
                bool_or(price IS NULL) AS has_unpriced_channel
         FROM trip_ext WHERE ${DAYWIN('requested_at')} AND driver_holds_cash ${PF()}
         GROUP BY 1 ORDER BY sum(price) DESC NULLS LAST, count(*) DESC LIMIT 12`, p),

      q(`SELECT platform,
                count(*) FILTER (WHERE outcome='not_completed')::int lost,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int judged,
                round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                      /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) AS pct
         FROM trip_norm WHERE is_booking AND ${DAYWIN('requested_at')} ${PF()}
         GROUP BY 1 HAVING count(*) FILTER (WHERE outcome IS NOT NULL) > 0
         ORDER BY 2 DESC`, p),
    ]);

    /* ── what capacity ADDED to this fleet actually produces ─────────────
       Every ceiling below is "n × the fleet's median earning vehicle". That is
       the right benchmark for reactivating a car an experienced driver will
       take, and the wrong one for capacity that is genuinely new — and this
       fleet has just run the experiment. It recruited 26 drivers in July after
       six months of almost no intake, and they did not produce anything like
       the median.

       So the median is reported as the ceiling and the observed first-month
       figure beside it, and the action says which applies. Sizing a
       redeployment plan on the median when new capacity delivers a third of it
       is how a plan misses by 3x while looking arithmetically sound. */
    /* From rollup_person_month, which is exactly this shape already: one row
       per person per month, with their bookings.

       What was here self-joined trip_norm to itself over the WHOLE history, on
       a regex-folded name, twice — 175,000 rows folded on each side and joined
       on the computed key. It was most of this endpoint's eleven seconds.

       It also folded names its own way — lowercase and whitespace, but NOT a
       repeated word — which made it the fifth definition of "the same person"
       in this codebase and the second that disagreed with the others. So
       "Najeeb Ullah Khan Khan" was a separate hire here, with his own ramp.
       The rollup is keyed on person_key, the one stored fold. */
    const [ramp] = await q(
      `WITH first_month AS (
         SELECT person_key, min(month) AS joined FROM rollup_person_month GROUP BY 1),
       last_day AS (SELECT max(covers_to) AS d FROM rollup_state),
       output AS (
         SELECT r.person_key, r.bookings
         FROM rollup_person_month r
         JOIN first_month f ON f.person_key = r.person_key AND r.month = f.joined
         -- Their first month must be a WHOLE month, or a driver who started on
         -- the 28th looks like a bad hire.
         WHERE f.joined < date_trunc('month', (SELECT d FROM last_day))
           AND f.joined >= date_trunc('month', (SELECT d FROM last_day)) - interval '6 months')
       SELECT count(*)::int n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY bookings) AS median_first_month
        FROM output`);

    /* ── a ceiling labelled "bookings/month" has to BE per month ──────────
       median_bookings is a median over the requested window, and every ceiling
       below multiplied it by a vehicle count and labelled the product
       "bookings/month". Measured on production: median_bookings came back 38 /
       120 / 1,656 at 7 / 30 / 365 days, so the SAME 31 blocked vehicles were
       sized at 1,163 / 3,705 / 51,336 "bookings/month" depending only on which
       range chip was selected, and the same 8 documents — whose 7-day horizon
       does not move at all — at 300 / 956 / 13,248.

       Worse, new_driver_first_month is a genuine calendar-month figure (19 at
       every window, because it is measured per month by construction), so the
       basis text compared a monthly number against a windowed one and read
       "50% of the median" at 7 days, "16%" at 30 and "1%" at 365 for the same
       two facts.

       Normalising once, here, is what makes every downstream figure agree at
       every window. 30 days is the month this fleet's rota and payout periods
       are quoted in. */
    const windowDays = Math.max(1,
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1);
    const medianWindow = Number(fleet?.median_bookings) || 0;
    const median = medianWindow * 30 / windowDays;
    const raw = [];

    /* "Put 1 vehicles back to work" was on the live page at days=365. Counts
       are interpolated into six titles and two of them also carry a they/it. */
    const s = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);
    /* These sentences are read beside tables where every number carries a
       separator, and they were interpolating raw integers: "2509 bookings",
       "1288 bookings lost at the door". */
    const n = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
    const they = (n) => (Number(n) === 1 ? 'it' : 'they');

    /* One place that decides an action's numbers, so no action can quietly
       omit a field or model from a different figure than it displays.

       Both were real: some actions carried no aed_* keys at all, so "nothing is
       modelled unless a rate is supplied" was true of the value and false of
       the shape; and one modelled from an unrounded ceiling while displaying a
       rounded one, printing AED 13 of upside against a ceiling of 0. A modelled
       figure has to be the rate times THE NUMBER ON SCREEN. */
    /* `direction` is not decoration. `bookings_ceiling` used to be
       acts.reduce over anything whose ceiling_unit matched /bookings/, and
       'bookings/month protected' matches — so renew_documents' 956 bookings of
       AVOIDED LOSS were summed into "Modelled upside" beside the redeployment
       ceiling of the very same cars. Money you keep and money you gain are
       different quantities and adding them produces one that is neither. */
    const act = (a) => {
      const ceiling = a.ceiling == null ? null : Math.round(a.ceiling);
      const modelable = ceiling != null && /bookings/.test(a.ceiling_unit || '');
      raw.push({
        direction: 'gain',
        /* Uniform on every action, so the mock and the real API answer in the
           same shape and the page never has to ask whether a key exists. */
        detail_of: null,
        ...a,
        ceiling,
        aed_measured: a.aed_measured == null ? null : Math.round(a.aed_measured),
        aed_modelled: rate && modelable && ceiling > 0 ? Math.round(ceiling * rate) : null,
      });
    };

    /* ── COLLECT: money already earned ─────────────────────────────────── */
    if (Number(recv?.amount) > 0) {
      act({
        id: 'collect_receivables', group: 'Collect', horizon: 'this week',
        title: `Chase AED ${Math.round(recv.amount).toLocaleString()} owed across ${recv.counterparties} `
          + s(recv.counterparties, 'counterparty', 'counterparties'),
        why: `${n(recv.trips)} ${s(recv.trips, 'booking')} in this window settle on account or against salary `
          + `rather than at the kerb. The oldest is ${recv.oldest_days} days old.`,
        basis: 'Sum of price over trip_ext rows flagged is_receivable — room charges, company accounts and '
          + 'salary postings. Measured, because these are the channels that report a fare.',
        size: recv.counterparties, size_unit: s(recv.counterparties, 'counterparty', 'counterparties'),
        aed_measured: Number(recv.amount),
        certainty: 'measured', effort: 'low',
        link: '#settlement/receivables',
        detail: recvRows.map((r) => ({
          counterparty: r.counterparty, partner_id: r.partner_id, driver_ext_id: r.driver_ext_id,
          settlement_class: r.settlement_class, trips: r.trips, amount: Number(r.amount),
          oldest_days: r.oldest_days,
        })),
      });
    }
    if (Number(cash?.trips) > 0) {
      act({
        id: 'reconcile_cash', group: 'Collect', horizon: 'this week',
        title: `Reconcile cash held by ${cash.drivers} ${s(cash.drivers, 'driver')} across `
          + `${n(cash.trips)} ${s(cash.trips, 'booking')}`,
        why: cash.priced < cash.trips
          ? `${n(cash.trips - cash.priced)} of those bookings come from a channel that reports no fare, so the `
            + `AED figure is a floor over the ${n(cash.priced)} that do.`
          : 'Every cash booking in this window reports a fare.',
        basis: 'trip_ext rows where the driver personally holds the money — a supervisor-collected fare is '
          + 'deliberately excluded, because it is not what a cash-handling control is sized on.',
        size: cash.drivers, size_unit: 'drivers holding cash',
        aed_measured: Number(cash.amount) || null,
        certainty: cash.priced < cash.trips ? 'partly measured' : 'measured', effort: 'low',
        link: '#settlement/cash',
        detail: cashRows.map((r) => ({
          driver: r.driver, driver_ext_id: r.driver_ext_id, plates: r.plates,
          trips: r.trips, priced: r.priced,
          amount: Number(r.amount), unpriced_channel: r.has_unpriced_channel,
        })),
      });
    }

    /* ── DEPLOY: capacity the fleet already owns ───────────────────────── */
    if (idle.length && median > 0) {
      const neverMoved = idle.filter((v) => !v.journeys).length;
      act({
        id: 'redeploy_idle_vehicles', group: 'Deploy', horizon: 'this month',
        title: `Put ${idle.length} ${s(idle.length, 'vehicle')} back to work — `
          + `${they(idle.length)} took no booking at all this window`,
        why: `${fleet.earning} of ${fleet.vehicles_seen} vehicles earned. ${neverMoved} of the idle ones did not `
          + `move either; ${idle.length - neverMoved} drove without a booking behind them, which is a different `
          + 'problem with a different fix.',
        basis: `The ceiling is ${idle.length} × the fleet's MEDIAN earning vehicle (${n(median)} `
          + `bookings a month, from ${Math.round(medianWindow)} over the ${windowDays} days requested), not `
          + 'its mean — a handful of very busy cars would otherwise set the target for every '
          + 'idle one. That benchmark assumes an experienced driver takes each car.'
          + (ramp?.median_first_month
            ? ` This fleet's last ${ramp.n} genuinely new drivers produced a median of `
              + `${Math.round(ramp.median_first_month)} bookings in their first whole month — `
              + `${Math.round((ramp.median_first_month / median) * 100)}% of the fleet median. Where these `
              + `cars need NEW drivers rather than existing ones, the realistic figure is nearer `
              + `${Math.round(idle.length * Number(ramp.median_first_month))} bookings, and the ceiling above `
              + 'is roughly three times it.'
            : ''),
        size: idle.length, size_unit: s(idle.length, 'vehicle'),
        ceiling: Math.round(idle.length * median), ceiling_unit: 'bookings/month',
        aed_measured: null,
        certainty: 'ceiling', effort: 'high',
        link: '#vehicles',
        detail: idle.slice(0, 12).map((v) => ({ plate: v.plate, journeys: v.journeys,
          last_booking: v.last_booking, driver_refs: v.driver_refs, driver_n: v.driver_n,
          held_by: v.held_by })),
      });
    }
    if (blocked.length) {
      act({
        id: 'recover_blocked_vehicles', group: 'Deploy', horizon: 'this week',
        title: `Reassign ${blocked.length} ${s(blocked.length, 'vehicle')} held by `
          + `${s(blocked.length, 'a driver', 'drivers')} who cannot earn on them`,
        why: 'Each of these people is suspended or deactivated on the platform whose vehicle they are holding. '
          + 'The car is the constraint in this business, not the person, so this is the cheapest capacity in it.',
        basis: 'driver_platform_state rows where the provider itself reports the driver stopped AND a plate is '
          + 'attached. This is the provider’s assertion, not an inference from quiet weeks. The ceiling uses '
          + 'the fleet median because these cars go to drivers already working, not to new hires — which is '
          + 'the reason this action sits above the idle-vehicle one despite being smaller.',
        size: blocked.length, size_unit: s(blocked.length, 'vehicle'),
        ceiling: Math.round(blocked.length * median), ceiling_unit: 'bookings/month',
        aed_measured: null,
        certainty: 'ceiling', effort: 'low',
        link: '#roster/blocked',
        detail: blocked.slice(0, 12).map((b) => ({ plate: b.plate, driver: b.full_name,
          driver_ext_id: b.driver_ext_id, state: b.state })),
      });
    }

    /* ── COVER: demand that turns up and nobody serves ─────────────────── */
    if (thinSlots.length) {
      const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const top = thinSlots[0];
      act({
        id: 'staff_thin_slots', group: 'Cover', horizon: 'next rota',
        title: `Roster ${thinSlots.length} ${s(thinSlots.length, 'hour')} that reliably `
          + `${s(thinSlots.length, 'carries', 'carry')} work and ${s(thinSlots.length, 'has', 'have')} `
          + 'three drivers or fewer',
        why: `The worst is ${DOW[top.dow]} at ${String(top.hour).padStart(2, '0')}:00 — ${n(top.trips)} bookings `
          + `across ${top.days_seen} occurrences, covered by ${top.drivers}. An hour held up by that few people `
          + 'stops working the day one of them is off.',
        basis: 'Weekday-hour cells with at least 20 bookings over at least 3 occurrences and 3 or fewer distinct '
          + 'drivers. Both halves are required: a thin hour with no demand is correctly unstaffed.',
        size: thinSlots.length, size_unit: s(thinSlots.length, 'hour'),
        certainty: 'observed', effort: 'medium',
        link: `#slot/${top.dow}/${top.hour}`,
        detail: thinSlots.slice(0, 12).map((s) => ({
          slot: `${DOW[s.dow]} ${String(s.hour).padStart(2, '0')}:00`,
          trips: s.trips, drivers: s.drivers, per_occurrence: s.trips_per_occurrence,
        })),
      });
    }

    /* ── IMPROVE: more out of what is already running ──────────────────── */
    if (Number(cancel?.lost) > 0) {
      act({
        id: 'reduce_cancellations', group: 'Improve', horizon: 'this month',
        title: `Recover some of ${n(cancel.lost)} ${s(cancel.lost, 'booking')} lost at the door (${cancel.pct}%)`,
        why: 'These were offered and did not complete — a rider no-show, a driver rejection, or a cancellation. '
          + 'Every one is demand the fleet already had.',
        basis: 'trip_norm.outcome, which normalises across platforms: Bolt reports a completed trip as '
          + '"finished" and three of its four failure modes never contain the word "cancel". Measured over the '
          + `${cancel.judged} bookings whose platform reports an outcome at all.`,
        size: cancel.lost, size_unit: `lost ${s(cancel.lost, 'booking')}`,
        /* The evidence here is one row per platform, not a sample of the lost
           bookings themselves, so the page must not offer to show "3 of 1,288".
           Every other action's detail IS a slice of the thing it counts. */
        detail_of: 'platform',
        /* Scaled to the month like every other ceiling on this page: cancel.lost
           is a count over the requested window, so at 365 days the unscaled
           quarter was a year's worth of recovery labelled per month. */
        ceiling: Math.round(cancel.lost * 0.25 * 30 / windowDays),
        ceiling_unit: 'bookings/month if a quarter are recoverable',
        aed_measured: null,
        certainty: 'ceiling', effort: 'medium',
        link: '#platforms/funnel',
        detail: cancelRows.map((r) => ({
          platform: r.platform, lost: r.lost, judged: r.judged, pct: r.pct == null ? null : Number(r.pct),
        })),
      });
    }
    if (strand.length) {
      const totalKm = strand.reduce((a, s) => a + Number(s.return_km || 0), 0);
      act({
        id: 'cut_return_deadhead', group: 'Improve', horizon: 'this month',
        title: `Cut ${Math.round(totalKm).toLocaleString()} km of unpaid return running from `
          + `${strand.length} drop-off ${s(strand.length, 'area')}`,
        why: `The worst is ${strand[0].place}: ${strand[0].drops} drops averaging ${strand[0].avg_return_km} km `
          + 'of empty running afterwards. A short paid trip ending somewhere remote costs more than a long one '
          + 'ending on a rank.',
        basis: 'Straight-line distance from the drop-off point to where the driver actually ended the job, which '
          + 'only the hotel channel reports. It understates road distance, so it is a floor.',
        size: strand.length, size_unit: `drop-off ${s(strand.length, 'area')}`,
        ceiling: Math.round(totalKm), ceiling_unit: 'unpaid km',
        direction: 'gain',
        certainty: 'measured', effort: 'medium',
        link: '#corporate/approach',
        detail: strand.slice(0, 8).map((s) => ({ place: s.place, drops: s.drops, avg_return_km: s.avg_return_km })),
      });
    }

    /* ── PROTECT: capacity about to stop being legal ───────────────────── */
    const soon = expiring.filter((d) => d.days_left <= 7);
    if (expiring.length) {
      act({
        id: 'renew_documents', group: 'Protect', horizon: soon.length ? 'today' : 'this month',
        /* Protect, not gain: this ceiling is bookings KEPT, and it was being
           summed into the same total as bookings won. */
        direction: 'protect',
        title: soon.length
          ? `Renew ${soon.length} vehicle ${s(soon.length, 'document')} expiring within 7 days`
          : `Renew ${expiring.length} vehicle ${s(expiring.length, 'document')} expiring within 45 days`,
        why: soon.length
          ? `${soon.length} ${s(soon.length, 'vehicle')} ${s(soon.length, 'stops', 'stop')} being able to work `
            + `legally within the week, and ${expiring.length - soon.length} `
            + 'more within 45 days. This is the only item here that avoids a loss rather than chasing a gain.'
          : `${expiring.length} ${s(expiring.length, 'vehicle')} ${s(expiring.length, 'has', 'have')} a document `
            + 'expiring within 45 days. None is urgent yet.',
        basis: 'vehicle_document rows with an expiry date inside 45 days. Counted in the database rather than '
          + 'from a capped list, because this tile makes a claim about whether a car may legally drive.',
        size: soon.length || expiring.length, size_unit: s(soon.length || expiring.length, 'vehicle'),
        ceiling: Math.round((soon.length || 0) * median), ceiling_unit: 'bookings/month protected',
        aed_measured: null,
        certainty: 'measured', effort: 'low',
        link: '#compliance',
        detail: expiring.slice(0, 12).map((d) => ({ plate: d.plate, expires_at: d.expires_at,
          days_left: d.days_left, held_by: d.held_by })),
      });
    }
    if (Number(licence?.expiring) > 0) {
      act({
        id: 'renew_licences', group: 'Protect', horizon: 'this month',
        direction: 'protect',
        title: `${licence.expiring} driver ${s(licence.expiring, 'licence')} `
          + `${s(licence.expiring, 'expires', 'expire')} within 45 days`,
        why: 'A driver whose licence lapses stops working on the day it does, whatever the rota says.',
        basis: 'driver_compliance rows with a real expiry date inside 45 days. The placeholder date this source '
          + 'writes for an unset field is excluded on the compliance page and is not an expiry.',
        size: Number(licence.expiring), size_unit: s(licence.expiring, 'driver'),
        certainty: 'measured', effort: 'low',
        link: '#compliance',
      });
    }

    /* Ordered by what it costs to leave alone: certainty first (a measured
       figure outranks a ceiling), then size. A ceiling that dwarfs a measured
       amount is not thereby more valuable — it is less certain. */
    const CERT = { measured: 0, 'partly measured': 1, observed: 2, ceiling: 3 };
    const HORIZON = { today: 0, 'this week': 1, 'next rota': 2, 'this month': 3 };
    const acts = raw;
    acts.sort((a, b) => (HORIZON[a.horizon] ?? 9) - (HORIZON[b.horizon] ?? 9)
      || (CERT[a.certainty] ?? 9) - (CERT[b.certainty] ?? 9)
      || (b.aed_measured ?? 0) - (a.aed_measured ?? 0)
      || (b.ceiling ?? 0) - (a.ceiling ?? 0));

    res.json({
      window: [from, to],
      window_days: windowDays,
      actions: acts,
      fleet: { ...fleet,
        /* Per month, matching the unit every ceiling below is labelled with.
           The window figure is kept beside it so the normalisation is checkable
           rather than a number that appeared from nowhere. */
        median_bookings: median ? Math.round(median) : null,
        median_bookings_window: medianWindow ? Math.round(medianWindow) : null,
        median_unit: 'bookings per 30 days',
        /* What capacity genuinely ADDED to this fleet produces in its first
           whole month, measured. Reported beside the median because the two
           differ by about 3x here and using the wrong one misses a plan by
           that factor while looking arithmetically sound. */
        new_driver_first_month: ramp?.median_first_month ? Math.round(ramp.median_first_month) : null,
        new_drivers_measured: ramp?.n || 0 },
      /* Totals kept apart on purpose. Adding a measured receivable to a
         modelled ceiling produces a number that is neither. */
      totals: (() => {
        /* Gain and protection are totalled apart. The old reduce matched
           /bookings/ against ceiling_unit, and 'bookings/month protected'
           matches — so renew_documents' avoided loss was added to the
           redeployment ceiling of the SAME cars and printed as upside.
           `bookings_ceiling` survives with the gain-only value it was always
           meant to carry, so the existing tile keeps working while naming the
           right quantity. */
        const bk = (x) => (/bookings/.test(x.ceiling_unit || '') ? (x.ceiling || 0) : 0);
        const gain = acts.filter((x) => x.direction !== 'protect');
        const protect = acts.filter((x) => x.direction === 'protect');
        const ceilGain = gain.reduce((a, x) => a + bk(x), 0);
        return {
          aed_measured: acts.reduce((a, x) => a + (x.aed_measured || 0), 0),
          aed_modelled: rate ? gain.reduce((a, x) => a + (x.aed_modelled || 0), 0) : null,
          aed_modelled_at_risk: rate ? protect.reduce((a, x) => a + (x.aed_modelled || 0), 0) : null,
          bookings_ceiling: ceilGain,
          bookings_ceiling_gain: ceilGain,
          bookings_at_risk: protect.reduce((a, x) => a + bk(x), 0),
          ceiling_unit: 'bookings per 30 days',
        };
      })(),
      assumption: rate
        ? { aed_per_trip: rate, note: 'Supplied by the caller. Every modelled figure is this rate times a ceiling.' }
        : { aed_per_trip: null,
          note: 'No revenue-per-booking rate supplied, so nothing is converted to money. Uber\'s fares '
            + 'come from a separate payments report collected a week at a time, so a measured rate covers '
            + 'its volume only as far back as that walk has reached — pass ?aed_per_trip= to model it, and '
            + 'read the result as an assumption.' },
    });
  }));
}
