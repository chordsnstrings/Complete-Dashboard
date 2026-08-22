/* Driver lifecycle: who joins, who stays, who quietly stops.
   ──────────────────────────────────────────────────────────────────────────
   This fleet's earning driver count ran 110, then 50, then 88 over ten months.
   A count that moves like that is compatible with two completely different
   businesses — one that keeps its people and stopped recruiting, and one that
   recruits constantly and cannot keep anybody — and the fix for each is the
   opposite of the fix for the other. A headcount cannot tell them apart. A
   cohort can.

   Every definition below is a choice, so each is stated:

   JOINED is the month of a driver's first booking anywhere, not the month a
   platform account appeared. An account created and never driven is not
   somebody who joined and left; it is somebody who never started, and the
   roster page counts those separately.

   ACTIVE IN A MONTH means at least one booking in it. Not "not suspended" — a
   platform can keep somebody nominally active for a year after their last
   trip, and on this fleet it does.

   STOPPED means absent from the last COMPLETE month having been present in the
   one before. The month in progress is excluded entirely: a driver who has not
   worked yet this week has not left. */

export function retentionRoutes(app, { q, wrap }) {
  app.get('/api/retention', wrap(async (req, res) => {
    const maxAge = Math.min(24, Math.max(3, Number(req.query.months) || 13));

    /* One row per person per month they booked. Folded by canonical name,
       because the same human holds a separate id on every platform and
       counting ids reports three drivers where there is one. */
    /* From rollup_person_month. This grouped every booking ever collected by
       person and month — no window, no index that helps — and cost 6.2
       seconds identically for every viewer. src/rollup.js computes it when the
       collector writes.

       Note the fold: this query used its own, which collapsed whitespace and
       case but NOT a repeated name part, so "Najeeb Ullah Khan Khan" was a
       different person here from everywhere else in the product and appeared
       as a separate cohort member. The rollup is keyed on person_key, the one
       stored fold, so retention now counts the same humans the rest of the
       pages do. */
    let activity = await q(
      `SELECT person_key AS person, name, to_char(month,'YYYY-MM') AS m, bookings, driver_ext_id
       FROM rollup_person_month ORDER BY person_key, month`);
    if (!activity.length) {
      activity = await q(
        `SELECT t.person_key AS person, max(n.driver_name) AS name,
                to_char(date_trunc('month', n.local_day), 'YYYY-MM') AS m,
                count(*)::int bookings,
                (array_agg(DISTINCT n.driver_ext_id) FILTER (WHERE n.driver_ext_id IS NOT NULL))[1] AS driver_ext_id
         FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
         WHERE n.is_booking AND t.person_key IS NOT NULL AND t.person_key <> ''
         GROUP BY 1, 3`);
    }

    if (!activity.length) {
      return res.json({ ok: false, reason: 'No booking in the record names a driver.' });
    }

    const [{ span_to: spanTo } = {}] = await q(
      `SELECT to_char(max(local_day), 'YYYY-MM-DD') AS span_to FROM trip_norm WHERE is_booking`);
    const lastOf = (ym) => {
      const [y, mo] = ym.split('-').map(Number);
      return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    };
    const allMonths = [...new Set(activity.map((r) => r.m))].sort();
    const currentMonth = allMonths[allMonths.length - 1];
    const currentIsPartial = !!spanTo && spanTo < lastOf(currentMonth);
    const months = currentIsPartial ? allMonths.slice(0, -1) : allMonths;

    if (months.length < 2) {
      return res.json({ ok: false,
        reason: 'Fewer than two complete months of booking history, so there is no cohort to follow. '
          + 'The month in progress is excluded: a driver who has not worked yet this week has not left.' });
    }
    const monthSet = new Set(months);
    const idx = Object.fromEntries(months.map((m, i) => [m, i]));

    const people = new Map();
    for (const r of activity) {
      if (!monthSet.has(r.m)) continue;
      const p = people.get(r.person)
        || { person: r.person, name: r.name, id: r.driver_ext_id, months: [], bookings: 0 };
      p.months.push(r.m);
      p.bookings += r.bookings;
      if (!p.id && r.driver_ext_id) p.id = r.driver_ext_id;
      people.set(r.person, p);
    }
    for (const p of people.values()) p.months.sort();

    /* ── cohorts ────────────────────────────────────────────────────────
       The first cohort is not a cohort. Everybody active in the first month of
       the record "joined" then as far as this data can see, including people
       who had been driving for years — so its curve describes the roster that
       already existed, not recruitment. Flagged rather than dropped, because
       hiding the largest group on the page raises more questions than it
       settles. */
    const byCohort = new Map();
    for (const p of people.values()) {
      const joined = p.months[0];
      const c = byCohort.get(joined) || { cohort: joined, size: 0, people: [] };
      c.size++; c.people.push(p);
      byCohort.set(joined, c);
    }

    const last = months[months.length - 1];
    const cohorts = [...byCohort.values()]
      .sort((a, b) => (a.cohort < b.cohort ? -1 : 1))
      .map((c) => {
        const start = idx[c.cohort];
        const horizon = months.length - start;
        const retained = [];
        for (let k = 0; k < Math.min(horizon, maxAge); k++) {
          const target = months[start + k];
          const n = c.people.filter((p) => p.months.includes(target)).length;
          retained.push({ offset: k, m: target, n, pct: Math.round((n / c.size) * 100) });
        }
        const stillActive = c.people.filter((p) => p.months.includes(last)).length;
        return {
          cohort: c.cohort, size: c.size, retained,
          still_active: stillActive,
          still_active_pct: Math.round((stillActive / c.size) * 100),
          months_observed: Math.min(horizon, maxAge),
          is_left_censored: c.cohort === months[0],
        };
      });

    /* ── who stopped, and who is new ────────────────────────────────────── */
    const prev = months[months.length - 2];
    const activeIn = (m) => new Set(
      [...people.values()].filter((p) => p.months.includes(m)).map((p) => p.person));
    const nowSet = activeIn(last), prevSet = activeIn(prev);

    const stopped = [...people.values()]
      .filter((p) => prevSet.has(p.person) && !nowSet.has(p.person))
      .map((p) => ({
        name: p.name, driver_ext_id: p.id,
        months_active: p.months.length,
        first_month: p.months[0], last_month: p.months[p.months.length - 1],
        lifetime_bookings: p.bookings,
      }))
      .sort((a, b) => b.lifetime_bookings - a.lifetime_bookings);

    const started = [...people.values()]
      .filter((p) => p.months[0] === last)
      .map((p) => ({ name: p.name, driver_ext_id: p.id, bookings: p.bookings }))
      .sort((a, b) => b.bookings - a.bookings);

    /* ── tenure, kept apart because one half is not finished ────────────── */
    /* Averaging people who are still working into a tenure figure counts an
       unfinished span as a finished one and understates every number. That is
       right-censoring, and the fix is to report the two separately rather than
       to pick one. */
    const tenureOf = (p) => idx[p.months[p.months.length - 1]] - idx[p.months[0]] + 1;
    const leavers = [...people.values()].filter((p) => !p.months.includes(last));
    const stayers = [...people.values()].filter((p) => p.months.includes(last));
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };

    /* The headcount, split into the parts that move it. This is the answer to
       the question the raw count cannot settle: whether a falling driver count
       is people leaving or nobody arriving. */
    const flow = months.map((m, i) => {
      const cur = activeIn(m);
      const before = i ? activeIn(months[i - 1]) : new Set();
      const joined = [...people.values()].filter((p) => p.months[0] === m).length;
      const returning = i
        ? [...cur].filter((x) => !before.has(x) && people.get(x).months[0] !== m).length : 0;
      const left = i ? [...before].filter((x) => !cur.has(x)).length : 0;
      return { m, active: cur.size, joined, returning, left, net: i ? cur.size - before.size : null };
    });

    res.json({
      ok: true,
      months,
      current_month_excluded: currentIsPartial ? currentMonth : null,
      cohorts,
      flow,
      last_complete_month: last,
      stopped_last_month: stopped,
      started_last_month: started,
      tenure: {
        median_months_leavers: median(leavers.map(tenureOf)),
        median_months_so_far_stayers: median(stayers.map(tenureOf)),
        leavers: leavers.length,
        stayers: stayers.length,
        note: 'Tenure for people still working is a lower bound — they have not finished. Averaging the two '
          + 'together counts an unfinished span as a finished one, so they are reported apart.',
      },
      people_total: people.size,
      caveat: 'A driver counts as active in a month when they took at least one booking in it. Platform '
        + '"active" status is deliberately not used: a platform can keep somebody nominally active for a year '
        + 'after their last trip, and on this fleet it does.',
    });
  }));
}
