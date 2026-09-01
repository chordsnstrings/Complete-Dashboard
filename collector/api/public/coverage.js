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
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, dayStr, dateStr,
  sourceLabel, countOf, plural, verdict } from './ui.js';
import { dubaiDay } from './tz.js';
import { q, api, state, href, currentGen, alive } from './data.js';

export async function renderCoverage(root) {
  root.innerHTML = '';
  loading(root);
  const gen = currentGen();
  /* The whole observed history, always — the window HIGHLIGHTS, it does not
     bound.
     ─────────────────────────────────────────────────────────────────────────
     At the default thirty days the fms panel read "No missing day inside this
     source's collecting span" and the KPI read "MISSING DAYS 1"; at 365 the
     same panel read "GAP STARTS Sep 24 / GAP ENDS Feb 22 / 152". A page whose
     entire subject is the difference between a quiet week and a week nobody
     collected must not itself hide a five-month hole behind a date range —
     and #sources links here with the words "152 days", landing on the version
     that denies it. Every figure below is over the record; the selected window
     is stated separately beside it. */
  const [all, win, ver] = await Promise.all([
    api('/api/coverage/calendar?from=2000-01-01&to=' + encodeURIComponent(dubaiDay())),
    q('/api/coverage/calendar').catch(() => null),
    /* Fetched here rather than beside its panel so the verdict at the top can
       use it. "Every source has a row for every day" is a true sentence and a
       misleading one on its own, and the qualification has to travel with the
       claim rather than sit four screens below it. */
    q('/api/coverage/verified').catch(() => null),
  ]);
  if (!alive(gen)) return;
  const c = all;
  root.innerHTML = '';
  if (!c.sources.length) return empty(root, 'No source has ever written a dated row.');

  const holed = c.sources.filter((s) => s.missing_days > 0);
  const winHoled = win ? win.sources.filter((s) => s.missing_days > 0) : [];

  /* Fields read off /api/coverage/calendar on production: each source carries
     total_rows, days_with_data, first_day, last_day, median_rows_per_day,
     gaps, missing_days, days.

     A hole here makes every rate computed across it wrong, on every other page
     in the product. That is the strongest claim any page in this app can make,
     and it was six tiles. */
  {
    const missing = c.sources.reduce((a, x) => a + (+x.missing_days || 0), 0);
    const worst = [...holed].sort((a, b) => b.missing_days - a.missing_days)[0];
    const missingFromUber = (ver && ver.trips_uber_has_that_we_never_stored) || 0;
    verdict(root, {
      claim: missing
        ? `${fmt(missing)} ${plural(missing, 'day')} ${missing === 1 ? 'is' : 'are'} missing from the record`
        : 'Every source has a row for every day it has been collecting',
      figure: fmt(holed.length), unit: 'sources with a hole',
      tone: missing ? (holed.length > 1 ? 'bad' : 'warn') : null,
      meta: `${fmt(c.sources.length)} sources`,
      sub: (worst
        ? `The worst is ${sourceLabel(worst.source)}, missing ${fmt(worst.missing_days)} of the days `
          + `between ${String(worst.first_day).slice(0, 10)} and ${String(worst.last_day).slice(0, 10)}. `
          + 'Every figure counted inside a source’s own span is only over the days it actually has.'
        : 'Counted inside each source’s own collecting span — a source that started in July is not '
          + 'missing June.')
        /* The sentence this claim needs in order not to mislead. A day is a
           gap here only when it has NO rows, so a day we collected a tenth of
           passes silently — and that is the failure actually on record: March
           2026 fell by three quarters in both fleets at once and this verdict
           called the year complete. */
        + ' This counts our own rows: a day with no rows is a hole, a day with a tenth of its rows is not.'
        + (missingFromUber
          ? ` Uber itself reports ${fmt(missingFromUber)} trips we never stored — see below.`
          : ' Uber’s own answer for the windows checked against it is below.'),
      recommend: missing
        ? 'Any rate on any page that crosses one of these gaps is an average over the days that '
          + 'were collected, not over the days that happened.'
        : null,
    });
  }

  root.append(kpiRow([
    { label: 'Sources with data', value: fmt(c.sources.length), sub: 'over the whole record' },
    { label: 'Sources with a hole', value: fmt(holed.length),
      sub: 'over the whole record', tone: holed.length ? 'warn' : 'good' },
    { label: 'Missing days, all history', value: fmt(c.sources.reduce((a, s) => a + s.missing_days, 0)),
      sub: 'inside each source’s own collecting span, over everything collected',
      tone: holed.length ? 'warn' : null },
    /* The window, beside the record rather than instead of it. */
    win
      ? { label: `Missing days in the last ${fmt(state.days)} days`,
        value: fmt(win.sources.reduce((a, s) => a + s.missing_days, 0)),
        sub: winHoled.length
          ? `${winHoled.map((s) => sourceLabel(s.source)).join(', ')}`
          : 'every source collected every day of the selected range',
        tone: winHoled.length ? 'warn' : 'good' }
      : { label: `Missing days in the last ${fmt(state.days)} days`, value: '—',
        sub: 'the windowed calendar could not be read' },
    { label: 'Rows on record', value: fmt(c.sources.reduce((a, s) => a + s.total_rows, 0)) },
  ]));

  /* ── the only figure on this page that is not our own opinion of ourselves ──
     Everything above counts rows in our tables. It is a real check — it found
     the eighteen-day Uber hole this page was built for — and it has one blind
     spot it can never see past: a day we collected a TENTH of has rows on it,
     so it is not a gap, so the calendar calls it collected.

     That blind spot is not hypothetical. Trips per active driver per day fall
     from 10.0 in February 2026 to 3.4 in March, and the fall lands in the same
     month, at the same three quarters, in BOTH fleets — Ecosine 17,385 to
     4,203, Egari 8,052 to 1,862 — two separate businesses on two separate Uber
     orgs. Two unrelated companies do not lose three quarters of their work on
     the same Sunday. The calendar above reported that year complete.

     So this panel is Uber's answer, not ours: a nightly job regenerates the
     same trip report the backfill collects from, for a window we already hold,
     and compares Uber's Trip UUIDs against the ones we stored. */
  {
    const rows = (ver && ver.windows) || [];
    const { panel: vp, body: vb } = panel('Checked against Uber, not against ourselves',
      'Uber’s own trip report for a window we already hold, matched booking by booking on Uber’s '
      + 'own trip id');
    root.append(vp);
    if (!rows.length) {
      vb.append(note('Nothing has been verified yet. Every figure above this panel counts our own rows, '
        + 'which can tell you a day collected nothing and cannot tell you a day collected a tenth of what '
        + 'happened. The nightly check verifies three windows per fleet and covers the full twelve months '
        + 'Uber retains inside a week; until it has run, treat the calendar above as evidence that the '
        + 'collector ran, not as evidence that it collected everything.'));
    } else {
      const miss = ver.trips_uber_has_that_we_never_stored || 0;

      /* The two horizons this panel does NOT cover, with their real dates.
         A reader who sees a month of trips confirmed will read it as "that
         month is verified", and for money and for ratings that is false in two
         different ways — one rolls forward and strands the past, the other has
         no past at all. Adjectives would not carry that; dates do.

         Placed ABOVE the numbers rather than under the table, because a green
         agreement figure read first sets the conclusion, and a qualification
         arriving four hundred pixels later does not undo it. */
      const h = ver.horizons || {};
      vb.append(el('p', 'cap',
        'Trips only, and the other two records do not reach as far back. '
        + (h.money && h.money.from_day
          ? `Uber money on record from ${dateStr(h.money.from_day)}; it is served on a rolling window of `
            + 'about 192 days, so everything before that is bookings with no money against them, '
            + 'permanently. '
          : 'No Uber money is on record. ')
        + (h.rating && h.rating.from_day
          ? `Ratings on record from ${dateStr(h.rating.from_day)} — Uber reports a rating as one current `
            + 'number with no history, so that record starts the day we first asked and can never be '
            + 'backfilled.'
          : 'No rating readings are on record yet; Uber reports a rating as one current number with no '
            + 'history, so this record can only start when the first reading is taken.')));

      /* What a hundred percent does and does not mean. The comparison is on
         Uber's trip id: it establishes that every booking Uber still lists
         for a window is a row in our table. It does not establish that the
         row is right — the collector upserts on (platform, external_id) and
         replaces every other column, so plate, driver, status and payment
         type can have moved under a month that matches perfectly by count.
         Said here rather than left to the word "checked", which a reader
         will hear as "correct". */
      vb.append(el('p', 'cap',
        'Matched on Uber\u2019s trip id: agreement means every booking Uber still lists for the window '
        + 'is a row in our table. It does not mean the rest of that row is right \u2014 a re-collection '
        + 'replaces everything but the id.'));
      vb.append(kpiRow([
        { label: 'Windows checked with Uber', value: fmt(ver.measured_windows),
          sub: ver.past_retention_windows
            ? `${fmt(ver.past_retention_windows)} more are past Uber’s retention and cannot be checked`
            : 'each one a separate Uber report' },
        { label: 'Trips Uber has that we never stored', value: fmt(miss),
          sub: miss ? 'these are real bookings missing from every figure in this product'
            : 'across every window checked so far',
          tone: miss ? 'critical' : 'good' },
        { label: 'Agreement', value: ver.agreement_pct == null ? '—' : `${ver.agreement_pct}%`,
          sub: `${fmt(ver.uber_rows)} on Uber’s side, ${fmt(ver.our_rows)} on ours, `
            + `over ${countOf(ver.measured_months, 'whole month')}`,
          tone: ver.agreement_pct == null ? null
            : ver.agreement_pct >= 99.5 ? 'good' : ver.agreement_pct >= 90 ? 'warn' : 'critical' },
        { label: 'Windows that disagree', value: fmt(ver.disagreeing_windows),
          sub: ver.errored_windows ? `${fmt(ver.errored_windows)} could not be asked` : 'of those checked',
          tone: ver.disagreeing_windows ? 'critical' : 'good' },
      ]));
      vb.append(tableFrom(rows, [
        { label: 'Window', key: 'window_from',
          /* Weeks are tagged, because a week window sits INSIDE a month
             window: a reader seeing two rows for overlapping ranges and no
             mark would read them as two independent checks and add them. */
          render: (r) => `${dateStr(r.window_from)} → ${dateStr(r.window_to)}`
            + (r.kind === 'week' ? ' <span class="tag dim">week</span>' : '') },
        { label: 'Fleet', key: 'fleet_id', render: (r) => esc(sourceLabel(r.fleet_id)) },
        { label: 'Uber says', key: 'uber_rows', num: true, render: (r) => fmt(r.uber_rows) },
        { label: 'We hold', key: 'our_rows', num: true, render: (r) => fmt(r.our_rows) },
        /* The number the panel exists for, so it is not buried between two
           counts that will usually look the same. */
        { label: 'Never stored', key: 'uber_only', num: true,
          render: (r) => (r.error ? '—'
            : `<span class="cov-miss${r.uber_only ? ' cov-miss-bad' : ''}">${fmt(r.uber_only)}</span>`) },
        /* Beside the loss column, never inside it. A trip we hold under the
           other fleet's name is a reconciliation defect and not a booking we
           lost, and merging the two would put the panel's worst possible
           overstatement in its headline column. */
        { label: 'Under other fleet', key: 'misfiled', num: true,
          render: (r) => (r.error || r.misfiled == null ? '—' : fmt(r.misfiled)) },
        { label: 'Agreement', key: 'agreement_pct', num: true,
          render: (r) => (r.agreement_pct == null ? '—' : `${r.agreement_pct}%`) },
        { label: 'Checked', key: 'verified_at', render: (r) => dayStr(r.verified_at) },
        /* Empty on every row means Uber answered every window cleanly, which
           is the good outcome and read as a broken column: bin/render-audit
           .mjs reported "Uber's answer is empty in all 12 rows". Declaring
           `absent` turns twelve blanks into one sentence saying so, and the
           cell is a dash rather than an empty string so a reader can see the
           column has a value to give. */
        { label: 'Uber’s answer', key: 'error',
          absent: 'Uber answered every one of these windows without complaint — no refusal, and '
            + 'nothing past the retention horizon',
          render: (r) => (r.past_retention ? '<span class="cap">past retention</span>'
            : r.error ? `<span class="cap">${esc(String(r.error).slice(0, 60))}</span>`
              : '<span class="ent-off" title="Uber served this window without an error">—</span>') },
      ]));
      const mis = ver.trips_filed_under_the_other_fleet || 0;
      if (mis) {
        vb.append(el('p', 'cap',
          `${fmt(mis)} further ${plural(mis, 'trip')} that Uber lists for one fleet `
          + `${mis === 1 ? 'is' : 'are'} in our table under the other one, and ${mis === 1 ? 'it is' : 'they are'} `
          + 'counted as held rather than as lost. The trip key is the platform and Uber’s id, and the fleet '
          + 'is an ordinary column the collector overwrites, so a trip both orgs can see ends up filed under '
          + 'whichever collected it last. Worth fixing for per-fleet reporting; nothing is missing.'));
      }
      const worst = rows.filter((r) => !r.error && (r.uber_only || 0) > 0)
        .sort((a, b) => b.uber_only - a.uber_only)[0];
      if (worst) {
        vb.append(el('p', 'note',
          `The worst is ${dateStr(worst.window_from)} → ${dateStr(worst.window_to)} for `
          + `${esc(sourceLabel(worst.fleet_id))}: Uber still serves ${fmt(worst.uber_rows)} trips for it and we hold `
          + `${fmt(worst.our_rows)}. Those ${fmt(worst.uber_only)} bookings are missing from every rate, `
          + 'every driver page and every revenue figure that crosses that window — and unlike the money '
          + 'below, they are recoverable: Uber is still serving them. Re-run the backfill for that range.'));
        /* Which days, not just how many. Four dead days inside a month and
           thirty-one thin ones are the same shortfall and completely different
           causes — the first is a window the backfill never landed, the second
           is a collection that was running and getting a fraction. Nothing
           else on this page can tell them apart. */
        const bad = (worst.days || []).filter((d) => (d.missing || 0) > 0)
          .sort((a, b) => b.missing - a.missing);
        if (bad.length) {
          const dead = bad.filter((d) => !d.ours).length;
          vb.append(el('p', 'cap',
            `The shortfall lands on ${countOf(bad.length, 'day')}`
            + (dead ? `, ${fmt(dead)} of which we hold nothing at all for` : ', every one of which we '
              + 'collected something for')
            + `. The worst is ${dateStr(bad[0].day)}: Uber ${fmt(bad[0].uber)}, we hold ${fmt(bad[0].ours)}. `
            + (dead
              ? 'Days with nothing at all are windows a backfill never landed; re-running it recovers them.'
              : 'A month of days each short by a fraction is a collection that was running and getting '
                + 'part of the answer, which is a different fault from a window nobody fetched.')));
        }
      }
    }
  }

  /* ── the hole that is not a collection failure ──────────────────────────
     Everything else on this page is a gap somebody can close by re-running a
     collector. This one nobody can: Uber's earnings API serves roughly the last
     six months, and the trip feed goes back a year — so half the record has
     bookings, distance and drivers with no money attached and none that can
     ever be fetched. Every backfill asked for those windows and every window
     answered ok and empty, which is indistinguishable from a quiet week unless
     it is said out loud. It belongs here because this is the page about the
     difference between the two. */
  const cov = await q('/api/coverage').catch(() => ({}));
  const moneyGaps = cov.earnings_gaps || [];
  if (moneyGaps.length) {
    const { panel: mp, body: mb } = panel('Work we hold no money for',
      'Where a platform\u2019s trip feed reaches further back than its earnings API will serve');
    mb.append(tableFrom(moneyGaps, [
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      /* With the year. These two dates are the whole point of the row and they
         are usually in different years — "Aug 21" beside "Feb 9" reads as five
         months forward when it is six months back. dayStr omits the year
         because most of this product is inside one window; this table is not. */
      { label: 'Trips from', key: 'trips_from', render: (r) => dateStr(r.trips_from) },
      { label: 'Money from', key: 'earnings_from', render: (r) => dateStr(r.earnings_from) },
      { label: 'Bookings before that', key: 'bookings_before', num: true,
        render: (r) => fmt(r.bookings_before) },
    ]));
    mb.append(note('These are not missing collections. The provider no longer serves statements for '
      + 'those windows, so the work is on record and the money is not, permanently. Any revenue figure '
      + 'over a range that reaches into them is measuring a shorter period than it appears to.'));
    root.append(mp);
  }

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
    /* A real name, and an anchor. The heading was the raw database key —
       "uber", "fms" — as a panel title, and #sources links to a source's
       section here with no way to reach it. */
    const { panel: p, body } = panel(sourceLabel(s.source),
      `${countOf(s.total_rows, 'row')} over ${countOf(s.days_with_data, 'day')} · `
      + `${dateStr(s.first_day)} → ${dateStr(s.last_day)} · median ${fmt(s.median_rows_per_day)}/day`);
    p.id = `src-${s.source}`;
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
        // The Dubai day, so a fix at 02:00 local counts on the day it happened.
        const key = dubaiDay(new Date(t));
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
        /* 791 cells each carrying a day's counts, and not one of them
           clickable, on a product where #day/<date> is a real address.
           display:contents so the anchor does not become a grid item of its
           own and shift every cell after it. */
        const link = el('a', 'cal-day');
        link.href = href('day', key);
        link.title = cell.title;
        link.append(cell);
        strip.append(link);
      }
    }
    body.append(strip);
    if (s.gaps.length) {
      /* Three states, and only one of them is a bug worth chasing. This page
         used to show a gap and stop, which meant a hole the provider has
         already answered "nothing" for looked exactly like a hole nobody had
         requested. The live FMS gap is the first kind: every window covering
         those 155 days was asked for and came back empty with no error. */
      body.append(tableFrom(s.gaps, [
        // The bounds of a gap are the two days worth opening: the last one
        // that worked and the first one that did not.
        { label: 'Gap starts', key: 'from', render: (g) => entity('day', String(g.from).slice(0, 10), dateStr(g.from)) },
        { label: 'Gap ends', key: 'to', render: (g) => entity('day', String(g.to).slice(0, 10), dateStr(g.to)) },
        { label: 'Days missing', key: 'days', num: true },
        { label: 'Was it asked for?', key: 'verdict', render: (g) => ({
          asked_and_empty: '<span class="tag ok">asked — provider returned nothing</span>',
          window_failed: '<span class="tag bad">a request inside it failed</span>',
          never_asked: '<span class="tag warn">not fully requested</span>',
        }[g.verdict] || '<span class="tag dim">unknown</span>') },
        /* A partly-requested gap and an entirely unrequested one are both
           "not fully requested" — you cannot conclude anything from a hole
           with unasked days in it — but the difference is between "start the
           backfill" and "it is nearly done". */
        { label: 'Days accounted for', key: 'days_answered', num: true,
          render: (g) => (g.days_answered == null ? '—'
            : [g.days_answered ? `${fmt(g.days_answered)} answered` : null,
               g.days_failed ? `<span class="dim">${fmt(g.days_failed)} failed</span>` : null,
               g.days_unrequested ? `<span class="dim">${fmt(g.days_unrequested)} never asked</span>` : null,
              ].filter(Boolean).join('<br>') || '—') },
      ], { compact: true, sortable: true, sortId: `gaps-${s.source}`,
        defaultSort: { key: 'days', dir: 'desc' } }));
      const askedDays = s.gaps_asked_and_empty || 0;
      const neverDays = s.gaps_never_asked || 0;
      const failedDays = s.gaps_window_failed || 0;
      const lines = [];
      if (askedDays) lines.push(`${countOf(askedDays, 'of these days was', 'of these days were')} `
        + 'requested and the provider returned no rows and no error. That is the provider\u2019s answer, '
        + 'not our bug — it is the date this source started reporting, and re-running the collector '
        + 'will not change it.');
      if (failedDays) lines.push(`${fmt(failedDays)} fall inside a window whose request FAILED. `
        + 'Those are worth re-running, and the reason is on the Data sources page.');
      if (neverDays) lines.push(`${countOf(neverDays, 'day has', 'days have')} no record of ever being `
        + 'requested — either the backfill has not reached them or it was cut short before it did.');
      if (lines.length) body.append(el('p', 'cap', lines.join(' ')));
    } else {
      body.append(el('p', 'cap',
        'No missing day inside this source’s collecting span, over the whole record.'));
    }
    root.append(p);
  });

  /* Arrive at the source somebody came here to look at. #sources links here as
     `#coverage?days=365&at=src-fms`; without this the reader lands at the top
     of a page eight panels long and has to find it again.

     It used to be a second '#' — `#coverage?days=365#src-fms` — and parseHash
     splits the hash on its first '?' and hands everything after it to
     URLSearchParams, so `days` came out as "365#src-fms", failed validation
     and fell back to thirty. The link said "the whole record" and opened one
     month of it. The old shape is still read, because a bookmark or a pasted
     link from before this fix should still land in the right place. */
  /* Not `q` — that name is the query helper imported from data.js at the top
     of this file, and a `const q` anywhere in the function puts every earlier
     use of it in the temporal dead zone. The page rendered "Cannot access 'q'
     before initialization" and its own error box. */
  const hashQuery = new URLSearchParams((location.hash.split('?')[1] || '').split('#')[0]);
  const anchor = hashQuery.get('at') || (location.hash.match(/#(src-[^?&#]+)$/) || [])[1];
  if (anchor) {
    requestAnimationFrame(() => {
      const target = document.getElementById(decodeURIComponent(anchor));
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  root.append(note('A gap is only counted between a source’s own first and last day. A source that '
    + 'started collecting in March is not missing January — it has no history there, which is a '
    + 'different statement and belongs in a different sentence.'));
}
