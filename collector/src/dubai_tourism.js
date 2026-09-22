/* Dubai's published visitor numbers, and what may be claimed from them.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for the forecast to take account of "total tourist coming
   in dubai, how that changed the number of trips last year". This file is the
   only place those figures live, because a regressor whose provenance is
   scattered across a route and a chart is a regressor nobody can audit.

   THIS IS A HAND-TRANSCRIBED LIST, not a collected feed. Nothing in this
   repository can reach Dubai's tourism authority; there is no API and no
   credential. So every row carries the publication it came from, and the list
   is checked against the aggregates the same authority published separately —
   see CHECKS below and `test/dubai_tourism.test.mjs`, which fails if the
   months and the totals stop agreeing. The counts in `CLAUDE.md` went stale
   once at 93 over 90; prose nobody checks is prose that lies, and a
   hand-typed table of numbers is the same hazard with more digits.

   THE PROVENANCE IS NOT UNIFORM AND THE PAGE SAYS SO. Three kinds of row:

     published_monthly  the authority published this month's figure by itself.
     published_total    an aggregate over several months, published as one
                        number. Kept as an aggregate. NEVER divided by the
                        number of months it covers — a monthly regressor faked
                        from a total is exactly the "reason that is not the
                        true one" this product exists to refuse.
     not_published      the authority has not published a figure for this month
                        at the monthly grain. Absent, with that as the reason.

   Dubai's Department of Economy and Tourism publishes cumulative
   year-to-date totals in its press releases and the full monthly series in its
   Tourism Performance Reports. The 2025 monthly series below is a secondary
   transcription of that series; what makes it usable is that it reconciles to
   the THREE separate DET aggregates in CHECKS, to the last significant digit
   each was published at. A table that hits H1, eleven months and the full year
   on the nose is the DET series or an extraordinary coincidence. */

/* ── the monthly series ─────────────────────────────────────────────────── */
/* International overnight visitors, in people. Dubai's headline tourism
   measure and the one every figure below is on. */
const DET = {
  name: 'Dubai Department of Economy and Tourism',
  short: 'Dubai DET',
};

export const VISITORS = new Map(Object.entries({
  '2025-01': { visitors: 1940000, basis: 'published_monthly' },
  '2025-02': { visitors: 1880000, basis: 'published_monthly' },
  '2025-03': { visitors: 1490000, basis: 'published_monthly' },
  '2025-04': { visitors: 1840000, basis: 'published_monthly' },
  '2025-05': { visitors: 1530000, basis: 'published_monthly' },
  '2025-06': { visitors: 1200000, basis: 'published_monthly' },
  '2025-07': { visitors: 1290000, basis: 'published_monthly' },
  '2025-08': { visitors: 1370000, basis: 'published_monthly' },
  '2025-09': { visitors: 1410000, basis: 'published_monthly' },
  '2025-10': { visitors: 1750000, basis: 'published_monthly' },
  '2025-11': { visitors: 1848000, basis: 'published_monthly' },
  '2025-12': { visitors: 2040000, basis: 'published_monthly' },
  '2026-01': { visitors: 1995000, basis: 'published_monthly' },
  /* February to July 2026 are NOT here on purpose. DET's releases through this
     stretch report the year to date and August by itself; no monthly figure
     for the six months between them has been published. They appear below as
     one aggregate, which is what was actually published, and they render on
     the page as absent with that reason. */
  '2026-08': { visitors: 869000, basis: 'published_monthly' },
}).map(([m, v]) => [m, {
  ...v,
  source: DET.short,
  published_by: DET.name,
  cited: v.basis === 'published_monthly'
    ? 'DET monthly tourism performance reporting'
    : null,
}]));

/* Months the authority has not published individually, with the true reason.
   Used by the page so that a gap in the regressor is a sentence rather than a
   hole in a chart. */
export const NOT_PUBLISHED = new Map(Object.entries({
  '2026-02': 'not published monthly',
  '2026-03': 'not published monthly',
  '2026-04': 'not published monthly',
  '2026-05': 'not published monthly',
  '2026-06': 'not published monthly',
  '2026-07': 'not published monthly',
}).map(([m, reason]) => [m, {
  reason: `Dubai's tourism authority has ${reason} for this month. It published the year to `
    + 'date and August by itself; the six months between them were released only as part of '
    + 'that total, and dividing a total by six would be an invention, not a measurement.',
}]));

/* ── aggregates, kept as aggregates ─────────────────────────────────────── */
export const AGGREGATES = [
  { from: '2026-02', to: '2026-07', visitors: 4106000,
    derived: true,
    label: 'February to July 2026, together',
    note: 'Not published as such. It is the published January-to-August total of 6.97 million '
      + 'less the two months inside it that were published individually (January 1.995m, '
      + 'August 869k). It is therefore a measured aggregate of six months and says nothing '
      + 'about any one of them.' },
];

/* ── the reconciliation, which is what makes the table trustworthy ──────── */
/* Each of these was published by DET as a single number, independently of the
   monthly series. If the months above ever stop summing to them, one of the
   two is wrong and the test says so rather than the page quietly drifting. */
export const CHECKS = [
  { label: 'H1 2025', from: '2025-01', to: '2025-06', expect: 9880000, tolerance: 15000,
    source: 'DET, "Dubai Welcomes 9.88 million International Visitors in H1 2025"' },
  { label: 'January to November 2025', from: '2025-01', to: '2025-11', expect: 17550000,
    tolerance: 60000,
    source: 'DET year-to-date reporting through November 2025 (~17.5 million)' },
  { label: 'Full year 2025', from: '2025-01', to: '2025-12', expect: 19590000, tolerance: 15000,
    source: 'DET via Dubai Media Office, 9 February 2026 — 19.59 million, a 5% rise on 18.72 '
      + 'million in 2024' },
];

export function reconcile() {
  return CHECKS.map((c) => {
    let got = 0;
    let missing = 0;
    for (const [m, v] of VISITORS) {
      if (m >= c.from && m <= c.to) got += v.visitors;
    }
    for (const m of NOT_PUBLISHED.keys()) if (m >= c.from && m <= c.to) missing += 1;
    return { ...c, got, missing, delta: got - c.expect,
      ok: missing === 0 && Math.abs(got - c.expect) <= c.tolerance };
  });
}

/* ── what happened to Dubai in 2026, because the break needs a cause ────── */
/* `src/forecast.js` refuses to fit across February→March 2026, where this
   fleet's bookings fell 77%. It refuses on the shape of the series alone,
   which is correct and is also the whole of what it can say. The reason is
   not in this database at all, and it is not a fact about this fleet:

     Dubai hotel occupancy   March 2025   over 71%
     Dubai hotel occupancy   March 2026   about 36%
     Dubai hotel occupancy   August 2026  66%, which DET put at 89% of August 2025
     Dubai airport, Q1       2025         23.4 million passengers
     Dubai airport, Q1       2026         18.6 million passengers

   A regional conflict from late February 2026 closed airspace and cancelled
   travel across the Gulf. The fleet did not lose 77% of its business; the city
   did. That matters for the forecast in one specific way: the recovery this
   page is fitting is a RECOVERY TO A KNOWN LEVEL, not open-ended growth, and
   the level is set by how far Dubai's visitor numbers come back. */
export const CONTEXT = [
  { m: '2026-03', kind: 'shock',
    headline: 'Dubai tourism collapsed, and the fleet went with it',
    detail: 'Regional conflict from late February 2026 closed airspace and cut travel across the '
      + 'Gulf. Dubai hotel occupancy fell to about 36% in March 2026 against over 71% in March '
      + '2025, and Dubai airport handled 18.6 million passengers in Q1 2026 against 23.4 million '
      + 'a year earlier. This fleet’s bookings fell 77% in the same month. The break this '
      + 'page refuses to fit across is a city-wide event, not a fleet one.' },
  { m: '2026-08', kind: 'recovery',
    headline: 'The recovery is the city’s, too',
    detail: 'DET reported 869,000 international overnight visitors in August 2026, the strongest '
      + 'month since February, after month-on-month growth in double digits since March, and '
      + 'hotel occupancy back to 66% — 89% of the August 2025 level. The fleet’s own '
      + 'recovery runs alongside it.' },
];

/* ── the demand calendar ────────────────────────────────────────────────── */
/* WHERE THIS CAME FROM MATTERS MORE THAN WHAT IT SAYS, so it is stated on the
   page beside it: this is a LANGUAGE MODEL'S ANSWER, not a measurement, and
   NOTHING ON THIS PAGE IS ADJUSTED BY IT. It annotates the months; it never
   multiplies a number.

   Generated 2026-09-22 with GLM 5.2 (`glm-5-2-260617`) on BytePlus ModelArk.
   It is here because a regression over six post-break months genuinely cannot
   know that Ramadan moves about eleven days earlier every Gregorian year, and
   therefore cannot know that the month which held Ramadan last year will not
   hold it next year. That is knowledge, not scatter, and it is the one thing
   worth paying a model for on this page.

   IT WAS CHECKED BEFORE IT WAS ALLOWED HERE, and the check is the reason this
   comment is long. The same calendar was first generated with MiniMax M3,
   which returned "Ramadan 1448 begins ~Feb 17 2027" and "Eid al-Fitr ~Mar 19
   2027". Those are 1447's dates — a year stale, wrong by nine days, and
   delivered with exactly the same confidence as everything else in the reply.
   GLM 5.2 returned ~8 February and ~9-11 March, which match the dates UAE
   outlets published in September 2026 from the astronomical calculation
   (Ramadan expected 8 February 2027, Eid al-Fitr 9 or 10 March, Eid al-Adha
   16 or 17 May, each subject to the moon sighting).

   So: two models, one of them wrong, no way to tell from the output which.
   Hence the rule this file enforces — a model may name an event, and may not
   move a number. */
export const CALENDAR_SOURCE = {
  model: 'GLM 5.2 (glm-5-2-260617) on BytePlus ModelArk',
  generated: '2026-09-22',
  checked: 'The Islamic dates were checked against UAE press reporting of the expected 2027 dates '
    + '(Ramadan from 8 February, Eid al-Fitr 9-10 March, Eid al-Adha 16-17 May, each subject to '
    + 'the moon sighting). An earlier run on a different model returned dates a year stale.',
  warning: 'Named by a language model, not measured. No figure on this page is adjusted by it.',
};

export const CALENDAR = new Map(Object.entries({
  '2026-10': { direction: 'up',
    events: ['GITEX Global (expected ~12-16 Oct 2026)', 'Autumn school term in session',
      'Cooler weather returns; tourism picks up'],
    note: 'GITEX draws tech visitors; cooler weather and returning tourists lift airport and evening trips.' },
  '2026-11': { direction: 'up',
    events: ['No Dubai Airshow this year — 2027 is the show year (next show Nov 2027)',
      'Autumn school term continues', 'Peak winter tourism season begins'],
    note: 'Mild weather and rising tourist arrivals sustain demand before the winter peak events arrive.' },
  '2026-12': { direction: 'up',
    events: ['UAE National Day (2-3 Dec 2026)',
      'Dubai Shopping Festival launches (expected ~26 Dec 2026)', 'New Year’s Eve (31 Dec)',
      'Winter school break begins (mid-Dec)'],
    note: 'DSF, National Day and New Year’s Eve drive major surges in rides and night-time demand.' },
  '2027-01': { direction: 'up',
    events: ['Dubai Shopping Festival continues (through late Jan 2027)', 'New Year’s Day',
      'Schools reopen mid-January', 'Peak winter tourism'],
    note: 'DSF’s final weeks plus peak winter tourism sustain high demand across malls and attractions.' },
  '2027-02': { direction: 'mixed',
    events: ['Ramadan expected to begin ~8 Feb 2027', 'Gulfood (expected ~21-25 Feb 2027)',
      'Dubai Shopping Festival ends (early Feb)', 'Schools in session'],
    note: 'Gulfood spikes trade visitors, but Ramadan shifts demand to iftar and suhoor and lowers daytime trips.' },
  '2027-03': { direction: 'mixed',
    events: ['Ramadan ends (~8 Mar 2027)', 'Eid al-Fitr expected ~9-11 Mar 2027',
      'Dubai World Cup (expected ~27 Mar 2027)', 'Spring school break (late March)'],
    note: 'Early Ramadan dents daytime trips; Eid, the Dubai World Cup and spring break then lift demand sharply.' },
  '2027-04': { direction: 'up',
    events: ['Spring holiday tourism', 'Post-Ramadan social activity rebounds',
      'Schools back in session; pleasant weather'],
    note: 'Spring travellers and post-Ramadan socialising lift airport transfers, malls and nightlife trips.' },
  '2027-05': { direction: 'mixed',
    events: ['Arabian Travel Market (expected ~3-6 May 2027)',
      'Eid al-Adha expected ~16-19 May 2027', 'Heat begins to build'],
    note: 'ATM boosts inbound trade visitors; Eid al-Adha then thins local demand as residents travel abroad.' },
  '2027-06': { direction: 'down',
    events: ['Dubai Summer Surprises begins (~late Jun 2027)',
      'Summer school holidays start (late Jun)', 'Summer exodus begins; heat intensifies'],
    note: 'Resident exodus and rising heat suppress daytime demand; mall traffic only partly offsets it.' },
  '2027-07': { direction: 'down',
    events: ['Dubai Summer Surprises continues', 'Peak extreme-heat month',
      'Summer school holidays continue; exodus peaks'],
    note: 'Peak heat and resident departures crush daytime demand; only mall and tourist-zone trips hold up.' },
  '2027-08': { direction: 'down',
    events: ['Dubai Summer Surprises continues', 'Peak extreme-heat month',
      'Schools reopen (late Aug 2027)'],
    note: 'The hottest month keeps residents away; demand stays low until they return and the weather eases.' },
  '2027-09': { direction: 'neutral',
    events: ['Schools reopen (early Sep 2027)', 'Weather begins to moderate', 'Pre-autumn-event lull'],
    note: 'Returning residents and cooler weather restore baseline demand before autumn events resume.' },
}));

/* The measured series disagrees with the calendar for September, and saying so
   is the point of keeping the two apart. The model calls September neutral;
   this fleet's own record has August→September as its largest seasonal step of
   the year (14,234 → 29,594 in 2025). Where the two disagree the measurement
   wins, because one of them is a measurement. */
export const CALENDAR_DISAGREEMENTS = ['2027-09'];
