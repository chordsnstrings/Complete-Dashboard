/* Unexplained occupancy, as pages you can send someone.
   ──────────────────────────────────────────────────────────────────────────
   This replaces four click paths that all opened the same modal — a day bar, a
   verdict slice, a vehicle bar and a table row — none of which had an address.
   The accusation "L44305 carried a passenger with no booking behind it" is the
   most serious thing this product says about anyone, and until now the only
   way to share it was a screenshot.

   Two pages:
     #segments[/<kind>/<value>]  the filtered list, with its own facets
     #segment/<plate>/<started>  one interval and everything around it

   The evidence page shows the neighbours, not just the nearest booking. That
   is the difference between "no booking within 15 minutes" and "here is every
   booking this car and this driver had within the hour, judge for yourself". */

import { empty, fmt, areaChart, hbars, donut } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill,
         dtStr, timeStr, dayStr, dateStr, money, custody, verdict, foldRows,
         sourceLabel, countOf, plural, asList, noneChosen,
         trackerState, trackerSpeed, stillNote, UBER_FARE_WHY,
         segSourceLabel, bySourceLine } from './ui.js';
import { q, qAll, api, href, state, unfiltered } from './data.js';

const VERDICT_TONE = { unauthorized: 'bad', authorized: 'ok', sensor_suspect: 'warn',
  partial: 'warn', stationary: null, unverifiable: 'warn', pending: null };

const VERDICT_MEANS = {
  unauthorized: 'The seat sensor reported a passenger, the vehicle covered real distance, and no booking on any collected channel overlaps this window.',
  authorized: 'Matched to a booking on a revenue channel.',
  sensor_suspect: 'Occupancy was implausibly long, or registered with the ignition off — consistent with a stuck seat pad rather than a passenger.',
  partial: 'A telemetry gap falls inside this window, so we cannot claim to have observed the whole interval.',
  stationary: 'Occupied, but the vehicle never really moved. Not a trip.',
  unverifiable: 'A revenue channel was unreadable when this was assessed, so "no booking" could not be established.',
  pending: 'Not yet reconciled.',
};

const vTag = (v) => `<span class="tag ${VERDICT_TONE[v] || 'dim'}">${esc(v || '—')}</span>`;

/* ═══ WHO WAS DRIVING, WHEN NOTHING BOOKED THE JOURNEY ══════════════════════
   Asked for in these words: "we can get the unauthorized trips on the time and
   date and we can match who drove that car using uber ... along with another
   tab of all unauthorized trips".

   THE DEFECT THIS ANSWERS. This list has always carried a column headed
   "Driver that day", fed by day-grain custody. The heading is honest and the
   column is useless at the moment it matters: a HANDOVER DAY names two people
   for one journey that had one driver, and an operator holding two names has
   an accusation they cannot act on. Measured on production over
   from=2026-08-01&to=2026-09-16, 120 unauthorized segments: 33 carried NO
   custody at all, 46 exactly one, 32 two, 8 three, 1 four. So 41 of 120 named
   more people than drove, and 33 named nobody while the column simply read
   "unknown" with no reason for it.

   WHAT REPLACES IT. /api/unauthorized/attributed runs a five-rung ladder whose
   SQL and whose measurements live in api/unauthorized_sql.js — nothing is
   decided in this file. Every name it produces is an INFERENCE (an unexplained
   journey is by definition one no booking explains, so no booking names its
   driver), and the page's job is to make the strength of each claim impossible
   to miss and impossible to average away:

     - the TIER is printed in front of the name, in every place a name appears;
     - the DISTRIBUTION of the tiers is printed ABOVE the list, so a reader
       knows what the page is before they read a single name. Measured over
       2026-06-01..2026-09-16: 13 named by time, 48 by day custody alone, 26
       with more than one candidate and 33 with nobody — two thirds of this
       feature is custody and absence, and a page that leads with names would
       be the dishonest version of it;
     - `ambiguous` prints EVERY candidate joined by "or", never a likeliest;
     - `unknown` prints the absence and its true reason, never the car's usual
       driver and never the nearest booking.

   The SENTENCES that define each tier are deliberately not written here. They
   arrive on the response as `tier_means`, authored beside the SQL that assigns
   them, so this page cannot come to explain a rung differently from the rule
   that fills it. What is local is the short label a chip and a table cell have
   room for, and the colour. */
/* FIVE RUNGS, not four. `last_trip` — the operator's own rule — was added to
   the ladder in api/unauthorized_sql.js and this file was not updated with it,
   so the chip row omitted the rung that carries most of the list and a row on
   it rendered its raw key, `last_trip`, as its own label. */
const TIER_ORDER = ['bracketed', 'last_trip', 'sole_custodian', 'ambiguous', 'unknown'];
const TIER_LABEL = {
  bracketed: 'Named by time',
  last_trip: 'Last Uber trip on the car',
  sole_custodian: 'Only custodian that day',
  ambiguous: 'More than one candidate',
  unknown: 'Nobody can be named',
};
/* Room for four words in a table cell, and the cell has a name beside it. */
const TIER_SHORT = { bracketed: 'by time', last_trip: 'last trip on the car',
  sole_custodian: 'only custodian', ambiguous: 'one of several', unknown: 'nobody' };
/* NO COLOUR RAMP DOWN THIS COLUMN, and that is not an oversight.
   ─────────────────────────────────────────────────────────────────────────
   This was { bracketed: 'ok', sole_custodian: null, ambiguous: 'warn',
   unknown: 'dim' } — a green tag beside a named person, an amber one beside
   another, a grey one beside a third. In this product a tone IS a verdict: a
   green 'ok' next to a name reads as "confirmed", when the green rung is still
   explicitly an inference and is the rung whose exclusion clause had to be
   widened across every channel before it could even claim what it said. The
   amber on `ambiguous` reads as "this one is suspicious" when it actually
   means "nothing separates these people". Together they rank four people by
   how strongly the product suspects them, which is precisely the choice the
   ladder refuses to make.

   api/public/driver.js renders the SAME ladder deliberately uncoloured and
   says why in its own block comment. Two surfaces, one ladder, one claim. The
   distinction is carried in WORDS — TIER_SHORT in the cell, TIER_LABEL on the
   chip, tier_means in the title — and in the evidence sentence beside it. */
const TIER_TONE = { bracketed: null, last_trip: null, sole_custodian: null,
  ambiguous: null, unknown: 'dim' };
/* Which rungs are a claim about ONE person and which are not. The band, the
   chips, the per-person table and the driver page all have to agree about
   this; four copies of `t === 'bracketed' || t === 'sole_custodian'` is four
   chances for one surface to count an ambiguous row as an accusation.

   THEY ARE NOT ONE NUMBER ANYWHERE THEY ARE SHOWN. isFirm answers "is this a
   claim about one person", which is the right question for deciding whether a
   row belongs in a candidate column — and it is the WRONG basis for a total,
   because 13 journeys named by time and 24 named by day-custody alone are
   different claims and a sum of them is the number that gets quoted. */
const FIRM = ['bracketed', 'last_trip', 'sole_custodian'];
const isFirm = (t) => FIRM.includes(t);
/* The rung that rests on a measurement of THIS journey's own clock, kept apart
   from the two that rest on the car's day. Used wherever a figure would
   otherwise average the three together. */
const isByTime = (t) => t === 'bracketed';

/* `tier` and `who` ride in the address's QUERY STRING rather than in a path
   slot. The router's KINDS list — verdict|plate|day|driver — lives in
   api/public/app.js and this file does not own it, and a filter that dies on
   reload is the thing #segments exists to have stopped doing. Same read the
   shell already does for `#driver/<id>?on=`. */
const hashQ = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k);

/* Keyed on the PARSED instant, not on the string.
   /api/segments and /api/unauthorized/attributed both select the same
   `occupancy_segment.started_at`, but they are two responses and a timestamp
   that round-trips as `2026-08-24T05:33:00.000Z` on one and `...+00:00` on the
   other would silently match nothing — every row would fall back to day
   custody and the feature would look like an empty deployment. */
/* And on the PROVIDER. A segment is (source, plate, started_at) since
   sql/schema_v85.sql: an FMS journey and an FMS live segment can start at the
   same second on one car, and keyed on plate and time alone one would take
   the other's attribution. A row with no source is CABMAN's — the shape
   before FMS was a seat sensor — on both responses alike. */
const segKey = (r) => `${r.source || 'cabman'}|${r.plate}|${Date.parse(r.started_at)}`;
/* A segment's address carries its provider, so two providers' segments that
   start at the same instant on one car open as themselves. */
const segHref = (r) => href('segment', r.plate, r.started_at, r.source ? { source: r.source } : null);

/* The attribution fields, named rather than spread wholesale.
   `clock_skew_min` is DELIBERATELY not in this list: /api/segments computes it
   by regex over verdict_reason (api/segment_routes.js SKEW) and the page's
   clock-skew warning is built from it, so letting the attribution response's
   own copy overwrite it would make the two disagree about which segments are
   unusable. Everything else here exists only on the attribution response. */
const ATT_FIELDS = ['attribution_tier', 'attribution_candidates', 'attribution_candidate_count',
  'attribution_candidate_keys', 'attribution_evidence', 'attribution_responsible',
  'attribution_last_trip_gap_min', 'attribution_last_uber_driver',
  'bracket_before_min', 'bracket_after_min',
  'custodian_count', 'unnamed_custodian_count', 'clock_skew_basis',
  'candidate_statuses', 'nearest_booking', 'status_note',
  'forgone_aed', 'aed_per_km', 'rate_basis'];

/* WHO THE EVIDENCE NAMES, as one table cell.
   ──────────────────────────────────────────────────────────────────────────
   Three disciplines, and each one is a way this cell could accuse somebody:

     - the TIER is in front of the name and is never optional, so a name
       cannot be read without the strength of the claim behind it;
     - on `ambiguous` every candidate is printed and joined by "or", not by a
       comma. A comma reads as a list of people who did it; "or" reads as the
       question it actually is;
     - on `unknown` nothing is printed but the absence and its reason. The
       nearest booking is on the row and is NOT offered here — its median gap
       over production's 106 populated rows is 97 minutes and its maximum is
       11,309, and on precisely the rows where nobody can be named it is the
       plausible name a reader would take for an answer.

   A row with no attribution at all is not the same as tier `unknown`, and the
   two must not render alike: `unknown` means the ladder ran and reached
   nobody, while an absent tier means the ladder was never run on this row —
   because it is not an unexplained journey, or because it is past the cap of
   the attribution list. That row keeps the day-custody content this column has
   always had, labelled as day custody so it cannot be read as a narrowed name. */
const attributionCell = (r) => {
  const tier = r.attribution_tier;
  if (!tier) {
    const day = custody(r, { title: 'This driver’s other flagged segments',
      hrefFor: (dr) => href('segments', 'driver', dr.name) });
    return `<span class="tag dim" title="${esc(r.attribution_absent
      || 'no attribution was computed for this row')}">day custody</span> ${day}`;
  }
  const cands = Array.isArray(r.attribution_candidates) ? r.attribution_candidates : [];
  /* The evidence sentence and the corroboration sentence, together, because
     they are read together: "their trip ended 54 minutes before and the next
     began 75 after" and "both candidates were offline on Uber for the whole
     window" answer different halves of the same doubt. */
  const why = [r.attribution_evidence, r.status_note].filter(Boolean).join(' ');
  const tag = `<span class="tag ${TIER_TONE[tier] || 'dim'}" title="${esc(why)}">${
    esc(TIER_SHORT[tier] || tier)}</span>`;
  /* KEYED ON THE TIER, NOT ON THE EMPTINESS OF THE LIST.
     ───────────────────────────────────────────────────────────────────────
     This branch read `if (!cands.length)` and then printed the tier tag
     followed by the words "nobody can be named". On the `unknown` rung
     TIER_SHORT is the single word "nobody", so the one row on the page where
     nobody can be named — the row a reader looks hardest at — rendered
     "NOBODY nobody can be named". And on any other rung an empty candidate
     array would have printed "by time nobody can be named": a tier tag flatly
     contradicting the text beside it, where the honest answer is that the row
     is faulty. */
  if (tier === 'unknown') {
    return `<span class="tag dim" title="${esc(why)}">nobody can be named</span>`;
  }
  if (!cands.length) {
    return `${tag} <span class="ent-off" title="${esc(why)}">a name was expected here and none `
      + 'arrived — this row is faulty rather than empty</span>';
  }
  const names = cands.map((c) => entity('driver', c.id, c.name))
    .join(tier === 'ambiguous' ? '<span class="dim"> or </span>' : ', ');
  /* Both gaps, stated rather than summarised. "Bracketed" is not checkable;
     "their trip ended 34 minutes before this and the next began 19 minutes
     after" can be checked against the car's own trip list in one click. */
  const gaps = tier === 'bracketed' && r.bracket_before_min != null && r.bracket_after_min != null
    ? `<span class="dim" title="their own Uber booking on this car ended this many minutes before `
      + `the journey opened, and their next began this many minutes after it closed"> · `
      + `−${fmt(r.bracket_before_min)}m / +${fmt(r.bracket_after_min)}m</span>`
    : '';
  return `${tag} ${names}${gaps}`;
};

/* ── the band that has to be read before any name is ───────────────────────
   "If most rows are ambiguous, the page must say so at the top." The four
   figures are the ones that tell an operator whether to trust the list at all,
   and the last of them is the one that decides it. Computed from
   `distribution`, which the endpoint measures over the WHOLE WINDOW rather
   than over the current filter — a tier count that changes when you pick a
   tier tells a reader nothing about what else is there. */
function attributionBand(root, att, pageRows = []) {
  const dist = att.distribution || {};
  const tiers = dist.by_tier || [];
  const n = dist.segments || 0;
  /* THREE FIGURES, AND THE HEADLINE RESTS ON THE FIRST ALONE.
     ───────────────────────────────────────────────────────────────────────
     The headline was `open > firm ? 'Most of this list cannot be narrowed to
     one person' : 'Most of this list narrows to one person'`, with tone 'ok'
     on the second branch and firm = bracketed + sole_custodian. Day-grain
     custody was being counted as "narrowed to one person". On the measured
     production distribution firm was 61 and open 59, so the page sat one
     segment away from flipping to a GREEN headline reading "Most of this list
     narrows to one person" over a list where 48 of those 61 were day custody
     and only 13 had been narrowed by time. The sub-line stated the full
     ladder; the headline and its tone are what a reader takes away. */
  const byTime = dist.bracketed || 0;
  const oneName = byTime + (dist.last_trip || 0) + (dist.sole_custodian || 0);
  const open = (dist.ambiguous || 0) + (dist.unknown || 0);
  const km = tiers.reduce((a, t) => a + (Number(t.km) || 0), 0);
  const rate = att.value?.aed_per_km;

  /* All five rungs. This named four and omitted `last_trip` — the operator's
     own rule, and the rung that carries most of the list — so the sentence
     under the headline did not add up to the total above it. */
  const ladder = `${fmt(byTime)} named by time, ${fmt(dist.last_trip || 0)} off the last Uber `
    + `trip on the car, ${fmt(dist.sole_custodian || 0)} by day custody alone, `
    + `${fmt(dist.ambiguous || 0)} with more than one candidate and `
    + `${fmt(dist.unknown || 0)} with nobody`;
  verdict(root, {
    claim: n === 0
      ? 'No unexplained journey in this window to attribute'
      : byTime * 2 >= n
        ? 'Most of this list is narrowed by time'
        : `${fmt(oneName)} of ${fmt(n)} carry one name, and ${fmt(byTime)} of those were `
          + 'narrowed by time',
    /* NO GREEN. There is no good news on this page: the best rung is still an
       inference and the tone would be read as the product agreeing. */
    tone: n === 0 ? null : open > oneName ? 'warn' : null,
    figure: n === 0 ? null : fmt(byTime),
    unit: `of ${fmt(n)} narrowed to one person BY TIME`,
    meta: n ? `${fmt(oneName - byTime)} carry one name off the car’s day instead · `
      + `${fmt(open)} carry no single name at all` : null,
    sub: n === 0
      /* "Nothing went unexplained" and "13 unexplained rows below" cannot both
         be true, and the page used to be able to print both. When the rows on
         screen contradict this zero, say so rather than leading with an
         exoneration the list itself disproves. */
      ? (pageRows.some((r) => r.verdict === 'unauthorized')
        ? `The attribution came back with nothing in it, and the list below holds ${
          fmt(pageRows.filter((r) => r.verdict === 'unauthorized').length)} unexplained `
          + 'journeys in this same window. Those two cannot both be right, so nothing here is '
          + 'an all-clear — read the list, and treat the missing names as missing rather than '
          + 'as absent.'
        : (att.coverage?.note
          || 'Nothing the seat sensor recorded in this window went unexplained.'))
      : `${ladder}. Every name below is an inference from the booking record, never a trip `
        + 'record of the journey itself — so a tier is printed in front of every one of them, '
        + 'and where the evidence cannot single out one person the page lists every candidate '
        + 'rather than choosing.',
  });

  root.append(kpiRow([
    { label: 'Unexplained journeys', value: fmt(n), tone: n ? 'bad' : 'good',
      sub: 'the seat sensor saw a rider, the car covered real distance, and no booking on any '
        + 'collected channel overlaps the window' },
    /* Revenue forgone, never "cost", and never without its rate — the same
       convention forgoneCell below and the segment page already use. */
    { label: 'Worth of the distance',
      value: rate == null || !km ? '—' : money(km * rate),
      sub: rate == null
        ? (att.value?.basis || 'no booking in this window carries both a fare and a distance, '
          + 'so there is no rate to value this at')
        /* Not "cost", and test/segment_routes.test.mjs enforces it within 600
           characters of the words "Revenue forgone" — which this tile is now
           the first occurrence of in the file. The product of a rate and a
           distance is what those kilometres would have earned, not a bill
           anybody paid; the fuel and wear behind them is a different, smaller
           number nothing here measures. */
        : `${fmt(km, 1)} km at the fleet’s own ${money(rate)}/km. Revenue forgone — what those `
          + 'kilometres would have earned had they been sold, not money anybody paid out.' },
    /* "Firmly attributed" was the heading over bracketed + sole_custodian.
       Neither word is right for day custody, and the tile counts what it is
       now called: how many journeys carry exactly one name, whatever put it
       there. The three rungs are named in the sub-line so the mixture is
       visible rather than averaged. */
    { label: 'Narrowed to one person', value: fmt(oneName), tone: null,
      sub: `${fmt(byTime)} bracketed by the same person’s own Uber trips either side · `
        + `${fmt(dist.last_trip || 0)} off the last Uber trip on the car, which is the `
        + 'operator’s rule and not a measurement of this journey · '
        + `${fmt(dist.sole_custodian || 0)} where one person held the car all day` },
    /* THE NUMBER THAT SAYS WHETHER TO TRUST THE LIST. Two absences, kept
       apart: more than one candidate is a question, no candidate at all is a
       gap in the trip record. Adding them into one "unattributed" would hide
       which of the two an operator can actually do something about. */
    { label: 'Cannot be narrowed', value: fmt(open),
      tone: open > oneName ? 'bad' : open ? 'warn' : null,
      sub: `${fmt(dist.ambiguous || 0)} have two or more people who held the car that day and `
        + `nothing separates them · ${fmt(dist.unknown || 0)} have no custody record at all` },
  ]));
}

/* ── the ladder, as the filter it should always have been ──────────────────
   "Group or filter by TIER so an operator can see at a glance how much of the
   list is firmly attributed and how much is ambiguous."

   The counts on these chips come from `distribution` — the whole window — and
   NOT from the rows on screen, for the same reason the verdict facet above
   does: a menu whose counts are computed after the filter is applied tells you
   only about the thing you already picked. */
function tierChips(root, att, { kind, value, tier, who }) {
  const dist = att.distribution || {};
  const means = att.tier_means || {};
  const p = panel('How firmly each journey is attributed',
    `${TIER_ORDER.length} rungs, strongest first. Click one to see only those.`);
  root.append(p.panel);
  const chip = (key, label, n, title) => `<a class="chip${tier === key ? ' on' : ''}" `
    + `title="${esc(title)}" href="${esc(href('segments', kind, value,
      { tier: key, who }))}">${esc(label)} <b>${fmt(n)}</b></a>`;
  p.body.append(el('div', 'chips',
    [chip(null, 'Every rung', dist.segments || 0,
      'every unexplained journey in this window, whatever the evidence says about it')]
      .concat(TIER_ORDER.map((k) => chip(k, TIER_LABEL[k], dist[k] || 0, means[k] || k)))
      .join('')));
  /* The vocabulary, written out rather than left in a tooltip. A reader who
     has to hover to find out what "sole custodian" claims is a reader who will
     read it as "the driver", which is the misreading this whole surface is
     built to prevent. */
  const dl = el('div', 'grid g2');
  TIER_ORDER.forEach((k) => {
    const box = el('div', 'note' + (TIER_TONE[k] === 'warn' ? ' warn' : ''));
    box.innerHTML = `<b>${esc(TIER_LABEL[k])}</b> — <span class="dim">${fmt(dist[k] || 0)} in `
      + `this window</span><br>${esc(means[k] || '')}`;
    dl.append(box);
  });
  p.body.append(dl);
  if (att.bracket?.rule) {
    p.body.append(el('p', 'cap',
      `${att.bracket.rule} The cap is ${fmt(att.bracket.cap_min)} minutes and the channel is `
      + `${(att.bracket.platforms || []).map(sourceLabel).join(', ')} — both were chosen by `
      + 'measurement and both move this distribution when they change, so they are stated here '
      + 'rather than buried in the rule.'));
  }
  /* WHY THERE IS NO "ON SHIFT" RUNG. Uber's own status feed is the strongest
     evidence in the building for "who was working at 14:32", and it names
     nobody on this population — a reader who knows the feed exists will ask,
     and the honest answer is a measurement rather than silence. */
  if (att.status_feed?.role) p.body.append(el('p', 'cap', att.status_feed.role));
}

/* ── who is named most often, keyed on the PERSON and not on the spelling ──
   The `driver` facet this page already had is `ILIKE '%name%'` against a
   comma-joined string of custodians: it matches by spelling, it will match a
   substring of somebody else's name, and it cannot be reached by person key.
   So there has never been a "who has the most unexplained journeys" ranking in
   the product, and the one built here keeps the two counts APART.

   They are two different claims about a person and they must never be added:
   "named beside this journey" and "held this car on a day something
   unexplained happened, along with somebody else" are not the same accusation,
   and a single total is the number that would get quoted. */
/* NO SINGLE "NAMED BESIDE" COLUMN, AND NO DEFAULT SORT ON A COUNT.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT THIS ANSWERS. This was a per-person suspicion leaderboard that
   re-merged what the ladder had just split. One column headed "Named beside"
   incremented on isFirm(t) — bracketed OR sole_custodian, and now the
   operator's last-trip rule as well — and the table was default-sorted on it
   descending, with Distance and Worth summed over the same union. Fleet-wide
   that added 13 time-grade rows to 48 custody-grade rows in one number, with
   money attached, and row one of the table read as "the person the product
   suspects most". Every one of the eight rows behind "Wisal · Named beside 8 ·
   184.0 km · AED 811" was sole_custodian — the product's own words for that
   rung are "this is custody, not driving".

   So the three rungs are three columns and they are never summed. The default
   sort is by NAME: any ordering the evidence knows is read as a ranking, which
   is the same reasoning api/unauthorized_sql.js gives for ordering an
   ambiguous candidate list alphabetically rather than by trip count.

   Worth and Distance are attached to the BY-TIME column alone. They are the
   rows where a measurement of this journey's own clock put one person in the
   frame; multiplying a day-custody inference by a rate produces a monetary
   claim against a person nothing placed behind that wheel. */
function whoPanel(root, rows, { kind, value, tier, who }, truncated) {
  const byKey = new Map();
  rows.forEach((r) => {
    const t = r.attribution_tier;
    if (!t || t === 'unknown') return;
    /* A ride once. From 2026-09-23 one ride on an FMS car is normally two rows
       here — FMS's live count and FMS's journey — both naming the same person;
       the server marks the one that represents the ride (counts_once), and a
       per-person count counts only that one. */
    if (r.counts_once === false) return;
    (Array.isArray(r.attribution_candidates) ? r.attribution_candidates : []).forEach((c) => {
      const key = c.key || c.id || c.name;
      if (!key) return;
      const cur = byKey.get(key)
        || { key, id: c.id, name: c.name, by_time: 0, last_trip: 0, custodian: 0,
          candidate: 0, km: 0, aed: 0 };
      if (isByTime(t)) {
        cur.by_time += 1;
        cur.km += Number(r.distance_km) || 0;
        cur.aed += Number(r.forgone_aed) || 0;
      } else if (t === 'last_trip') cur.last_trip += 1;
      else if (isFirm(t)) cur.custodian += 1;
      else cur.candidate += 1;
      byKey.set(key, cur);
    });
  });
  const people = [...byKey.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!people.length) return;

  const p = panel('Who the evidence names',
    'One column per rung of the ladder, and they are never added together');
  root.append(p.panel);
  const num = (n, title) => (n
    ? `<span title="${esc(title)}">${fmt(n)}</span>`
    : '<span class="ent-off">—</span>');
  const t = tableFrom(people, [
    { label: 'Person', key: 'name', render: (r) => entity('driver', r.id, r.name) },
    { label: 'Named by time', key: 'by_time', num: true,
      render: (r) => num(r.by_time, TIER_LABEL.bracketed + ' — ' + TIER_SHORT.bracketed) },
    { label: 'Last trip on the car', key: 'last_trip', num: true,
      render: (r) => num(r.last_trip, 'the operator’s rule: theirs was the last Uber trip on '
        + 'that car before the journey. An inference from the car’s Uber record, not a record '
        + 'of the journey') },
    { label: 'Sole custodian that day', key: 'custodian', num: true,
      render: (r) => num(r.custodian, 'they are the only person the trip record shows holding '
        + 'that car that Dubai day. This is custody, not driving') },
    { label: 'One of several', key: 'candidate', num: true,
      render: (r) => num(r.candidate, 'they are one of two or more people the record cannot '
        + 'separate. No claim is made') },
    /* Only on the by-time rows. See the block above. */
    { label: 'Distance named by time', key: 'km', num: true,
      render: (r) => (r.km ? `${fmt(r.km, 1)} km` : '<span class="ent-off">—</span>') },
    { label: 'Worth of those', key: 'aed', num: true,
      render: (r) => (r.aed ? money(r.aed) : '<span class="ent-off">—</span>') },
    { label: '', key: 'key',
      render: (r) => `<a class="dim" title="only this person’s journeys" href="${
        esc(href('segments', kind, value, { tier, who: r.key }))}">⌕</a>` },
  ], { compact: true, sortable: true, sortId: 'segwho',
    defaultSort: { key: 'name', dir: 'asc' } });
  foldRows(p.body, t, { shown: 10, total: people.length, noun: 'person', key: 'segwho' });
  p.body.append(el('p', 'cap',
    'Four counts per person and <b>none of them may be added to another</b>. <b>Named by time</b> '
    + 'is the only one measured against this journey’s own clock: their own Uber trips bracket '
    + 'it, with no other driver’s booking on the car in between. <b>Last trip on the car</b> is '
    + 'the operator’s rule — whoever finished the last Uber trip on that car before the journey '
    + '— which is an inference from the car’s record and not about the journey. <b>Sole '
    + 'custodian that day</b> is day-grain custody: this is custody, not driving. <b>One of '
    + 'several</b> is not an accusation at all. The money and the distance are attached to the '
    + 'by-time column alone, because pricing a custody record produces a debt nobody measured. '
    + 'Folded on the person, so a driver with an Uber and a Yango account is one row, not two — '
    + 'and a ride two seat-sensor providers both saw is counted once.'
    /* THE COUNTS ARE OVER WHAT IS ON SCREEN. /api/segments caps at 300 and a
       plate or day facet narrows it further, while the chips above carry
       window-wide figures. A per-person count that is silently a floor is the
       one number on this panel that must not be approximate. */
    + (truncated
      ? ' <b>These counts are a floor.</b> The list behind them is capped, so a person whose '
        + 'other journeys fall past the cap is undercounted here. Narrow by vehicle or day.'
      : '')));
}

/* The list. `kind` is one of verdict|plate|day|driver, so every facet chip is
   a real destination rather than an in-page filter that dies on reload. */
export async function renderSegments(root, kind, value) {
  root.innerHTML = '';
  loading(root);
  /* THE BARE ADDRESS NOW MEANS THE UNEXPLAINED ONES.
     ───────────────────────────────────────────────────────────────────────
     "Another tab of all unauthorized trips" had no address. #segments was not
     in the rail at all, #unauthorized has no tab bar and folds its segment
     list to eight of N, and the only ways to reach the full list were a donut
     slice and a verdict chip. So this page is the tab, it is registered in the
     rail, and the address it is registered at has to MEAN what the rail calls
     it: `#segments` is every unauthorized trip, and `#segments/verdict/all` is
     every occupancy interval whatever the reconciler decided. Nothing else
     changes — `verdict=all` is a value /api/segments has always accepted and
     always turned into no filter at all. */
  const defaulted = !kind;
  const k = kind || 'verdict';
  const v = kind ? value : 'unauthorized';
  const extra = {}; extra[k] = v;
  const tier = TIER_ORDER.includes(hashQ('tier')) ? hashQ('tier') : null;
  const who = hashQ('who') || null;
  const [d, attRaw] = await Promise.all([
    q('/api/segments', extra),
    /* The ladder is only meaningful on an unexplained journey — a matched
       segment has a booking behind it and the booking names its own driver —
       so this asks about `unauthorized` whatever the list above is showing.

       qAll, not q: THE TWO ENDPOINTS DISAGREE ABOUT THE FLEET CHIP, and the
       disagreement renders as a contradiction rather than as a filter.
       /api/segments binds the window, the verdict, the plate, the day and the
       driver and NOT the fleet — api/segment_routes.js destructures only
       [from, to] out of range(req) — while /api/unauthorized/attributed binds
       it properly. Asked with fleet=egari the attribution comes back empty with
       a coverage note reading "no seat-occupancy evidence exists for this
       window at all", printed directly above a table of forty Ecosine
       segments: two halves of one page contradicting each other, which is
       worse than either of them being wrong alone. So the attribution is asked
       the question the list actually answers — every fleet — and the chip is
       named as governing nothing below. The fix belongs in segment_routes.js.

       Caught rather than awaited bare: this endpoint is newer than the shells
       that read this page, and a list that dies because an attribution service
       is not deployed yet is worse than a list with no attribution on it. */
    qAll('/api/unauthorized/attributed', { verdict: 'unauthorized', limit: 500 })
      .catch(() => null),
  ]);
  root.innerHTML = '';

  /* A 200 CARRYING THE WRONG BODY IS A FAILURE, NOT AN EMPTY ANSWER.
     ───────────────────────────────────────────────────────────────────────
     The catch above stops a THROWN request; it does nothing about a response
     that arrives with a status of 200 and a shape this page cannot read — a
     bare `[]` from a mock's catch-all route, a proxy or a cache that rewrote
     the body, a deploy where the endpoint is not there yet. `[]` is truthy, so
     it passed the `att ? … : null` test below and was then read as an object:
     `att.distribution` came back undefined, the band computed n = 0 and
     rendered its zero branch — the claim "No unexplained journey in this
     window to attribute" and the sub-line "Nothing the seat sensor recorded in
     this window went unexplained." — in the page's headline verdict slot,
     directly above KPI tiles reading UNEXPLAINED 13 and a 13-row table of
     off-book journeys fetched separately and perfectly fine.

     That is the one failure mode the house principle forbids: a figure that
     could not be measured rendered as zero, with a reason that is not the true
     one, and in this case the strongest possible exoneration of the whole
     fleet. So the body is VALIDATED, and anything that does not carry a
     distribution takes the same degraded path a thrown request already took —
     the day-custody column, no band, and the note below saying why. */
  const att = attRaw && attRaw.distribution ? attRaw : null;
  const attFailed = !att;

  /* The attribution, merged onto the rows this page already had rather than
     rendered as a second list beside them. Two pages listing the same journeys
     differently is worse than one page listing them incompletely. */
  const attOf = att ? new Map((att.rows || []).map((r) => [segKey(r), r])) : null;
  d.rows = (d.rows || []).map((r) => {
    const a = attOf && attOf.get(segKey(r));
    if (a) return Object.assign({}, r, Object.fromEntries(ATT_FIELDS.map((f) => [f, a[f]])));
    if (!attOf) return r;
    /* The TRUE reason this row carries no name and no value, which is a
       different sentence for each of the two ways it can happen. Without it
       the money column renders "—" under forgoneCell's default title — "no
       distance was measured across this interval" — which is a claim about
       the vehicle rather than about our arithmetic, and it is false. */
    const absent = r.verdict === 'unauthorized'
      ? `this journey is past the ${fmt(att.limit)} most recent unexplained journeys the `
        + 'attribution list returns, so no name and no value were computed for it'
      : 'the attribution ladder is only run on unexplained journeys — a booking explains this '
        + 'one, and that booking names its own driver and carries its own fare';
    return Object.assign({}, r, { attribution_absent: absent, rate_basis: absent });
  });

  /* ── the band, and it goes above every name on the page ─────────────────
     Rendered before the segment KPIs rather than after them, because it is the
     thing that says whether the names below are worth reading. */
  if (att) attributionBand(root, att, d.rows);
  /* ABSENT WITH A REASON, and the reason is about US. An attribution that
     could not be read is not an attribution that found nothing, and the
     difference is the whole page. */
  if (attFailed) {
    root.append(note('Who the evidence names could not be loaded for this window — the '
      + 'attribution service did not answer, or answered with something this page cannot read. '
      + 'The list below is unchanged and complete; what is missing is the NAME beside each '
      + 'journey and the rung that justifies it. This says nothing about whether these '
      + 'journeys can be attributed. The column falls back to day-grain custody, labelled as '
      + 'such.', 'warn'));
  }

  /* A control on screen that changes nothing has to say so. See the note on
     the qAll above: neither this list nor its attribution is narrowed by the
     fleet chip, and the fleets actually on screen are named rather than
     asserted. Since 2026-09-23 both fleets have a seat-sensor provider —
     CABMAN DT and FMS on Ecosine, FMS on Egari — so a list holding one fleet
     only is a window where the other's providers produced nothing, and the
     sentence says that rather than blaming an absent sensor. */
  if (state.fleet) {
    const fleets = [...new Set(d.rows.map((r) => r.fleet_id).filter(Boolean))];
    root.append(note(`The fleet chip above reads ${sourceLabel(state.fleet)}, and nothing on this `
      + 'page is narrowed by it: the endpoint behind this list binds the window, the verdict, the '
      + 'vehicle, the day and the driver, and not the fleet. '
      + (fleets.length
        ? `Every segment shown belongs to ${fleets.map(sourceLabel).join(' or ')}`
          + `${fleets.length === 1 && fleets[0] !== state.fleet
            ? ' — no seat-sensor provider produced a segment for the fleet selected in this '
              + 'window, so an empty page here would have meant no evidence rather than a clean '
              + 'fleet' : ''}.`
        : 'No segment is shown at all in this window.'), 'warn'));
  }

  /* THE OTHER INERT CONTROL, WHICH HAD NO NOTE AT ALL.
     ───────────────────────────────────────────────────────────────────────
     The fleet chip gets four lines above explaining that it governs nothing
     here. The PLATFORM chip is equally inert — /api/segments binds no platform
     and /api/unauthorized/attributed deliberately does not either — and said
     nothing. Selecting Bolt changed not one character of this page, with the
     control still reading Bolt, while the chip beside it got a paragraph about
     precisely that situation. A true reason exists and was written in the
     endpoint's own header; it never reached the screen. */
  if (state.platform) {
    root.append(note(`The platform chip above reads ${sourceLabel(state.platform)}, and nothing `
      + 'on this page is narrowed by it — not the list, not the counts, and not the names. An '
      + 'occupancy segment is a CAR’s own movement, recorded by a seat sensor and a GPS trace; '
      + 'it does not belong to a booking channel at all, and the entire meaning of the verdict '
      + 'below is that no channel explains it. Filtering these journeys by channel would '
      + 'return an empty page and call it a clean one, so the control is left showing every '
      + 'one of them instead.', 'warn'));
  }

  const vf = d.facets.verdict || [];
  const unauth = vf.find((r) => r.key === 'unauthorized');
  const totalAll = vf.reduce((a, r) => a + r.n, 0);
  /* Which channels were unreadable, named. "Assessed blind 37" is a count of
     segments nobody can act on until they know WHICH source was down, and
     every row carries `unavailable_sources`. */
  const blindSources = [...new Set((d.rows || [])
    .filter((r) => r.low_confidence)
    .flatMap((r) => asList(r.unavailable_sources)))];
  /* The two headline tiles are TOTALS, so they count a ride once across the
     providers (the facets are counted that way on the server); the rows below
     are every provider's segment, and `Matching this filter` is their count.
     Each provider's own figures and the rule relating them follow the tiles. */
  const rawAll = vf.reduce((a, r) => a + (r.segments ?? r.n), 0);
  root.append(kpiRow([
    { label: 'Segments in window', value: fmt(totalAll),
      sub: rawAll > totalAll
        ? `every occupancy interval seen, a ride counted once — ${fmt(rawAll)} segments across providers`
        : 'every occupancy interval seen, a ride counted once across providers' },
    { label: 'Unexplained', value: fmt(unauth?.n || 0),
      /* Null distance is not zero km. */
      sub: unauth?.km != null ? `${fmt(unauth.km)} km carried off-book`
        : (unauth?.n ? 'no distance was measured on these segments' : 'nothing unexplained to measure'),
      tone: unauth?.n ? 'bad' : 'good' },
    { label: 'Matching this filter', value: fmt(d.total),
      sub: defaulted ? 'verdict = unauthorized, which is what this page is'
        : `${kind} = ${value}` },
    { label: 'Assessed blind', value: fmt(d.low_confidence),
      sub: blindSources.length
        ? `${blindSources.map(sourceLabel).join(', ')} could not be read when these were judged`
        : 'a revenue channel was unreadable when these were judged',
      tone: d.low_confidence ? 'warn' : null },
  ]));

  /* The clock guard, said out loud.
     ─────────────────────────────────────────────────────────────────────────
     A telematics feed whose clock disagrees with wall time cannot be matched
     against bookings, so the reconciler refuses to judge those segments. It is
     right to refuse — and the refusal was invisible: /api/segments has returned
     `clock_skew` since the guard was written, and this page rendered none of
     it, so a run of unjudged segments would have read as a clean fleet.

     This is the same shape as the bug that made the Unauthorized page report
     zero for the life of the project: a guard that fires correctly, suppresses
     a verdict, and says nothing. It reads zero on this fleet today, which is
     exactly when to wire it up — the day a tracker's clock drifts, the page
     will say so instead of going quiet. */
  const skew = d.clock_skew || {};
  if (skew.segments) {
    root.append(note(`${countOf(skew.segments, 'segment')} could not be judged at all: the tracker on `
      + `${skew.plates?.length ? skew.plates.join(', ') : 'at least one vehicle'} reported times `
      + `${skew.max_min != null ? `up to ${fmt(Math.abs(skew.max_min))} minutes ` : ''}out of step with `
      + 'the clock the bookings are stamped in, and a segment that cannot be lined up against a booking '
      + 'cannot be called authorised or unauthorised. They are excluded from every verdict above rather '
      + 'than counted as clean.', 'warn'));
  }

  /* EACH PROVIDER'S OWN FIGURES, and the rule that relates them to the tiles.
     A provider with nothing in the window reads "no evidence" with its true
     reason as the title — CABMAN DT over a window before it was collected is
     not a clean fleet. */
  const src = d.facets.source || [];
  if (src.length) {
    const byS = Object.fromEntries(src.map((x) => [x.key, x]));
    const c = el('p', 'cap');
    c.innerHTML = `Unexplained segments by provider: ${bySourceLine(byS, 'unauthorized')}. `
      + `Segments by provider: ${bySourceLine(byS, 'segments')}. ${esc(d.dedupe_rule || '')}`;
    root.append(c);
  }

  /* The range selector implies a history the seat sensors do not all have.
     When CABMAN was the only one, a five-minute poll with nothing behind it,
     "0 unexplained over 30 days" read as thirty days of clean driving over the
     few days it had ever recorded. Three sources now reach back three
     different distances, and the sentence says so instead of claiming the
     window's edge is the evidence's. */
  const days = d.facets.day || [];
  if (days.length) {
    root.append(el('p', 'cap',
      `Seat-occupancy evidence exists for ${countOf(days.length, 'day')} in this window — `
      + `${dateStr(days[0].key)} to ${dateStr(days[days.length - 1].key)}. CABMAN DT’s pad and FMS’s `
      + 'live seat count are polls with no history behind them; FMS journeys reach back about two years '
      + 'but are judged only over the windows the reconciler has run. A day with no segment is a day no '
      + 'provider watched, not a quiet one.'));
  }

  /* What is currently being shown, and the way back out of it — including out
     of the DEFAULT, which is itself a filter and would otherwise be the one
     narrowing nobody could see or undo. */
  const clear = el('div', 'note');
  clear.innerHTML = defaulted
    ? 'Showing <b>every unexplained journey</b> — the ones the seat sensor recorded and no '
      + `booking explains. <a href="${esc(href('segments', 'verdict', 'all'))}">Show every `
      + 'occupancy interval instead</a>, matched ones included.'
    : (k === 'verdict' && v === 'all'
      ? 'Showing <b>every occupancy interval</b>, whatever the reconciler decided about it. '
        + `<a href="${esc(href('segments'))}">Back to the unexplained ones</a>.`
      : `Filtered to <b>${esc(k)} = ${esc(v)}</b>. `
        + `<a href="${esc(href('segments'))}">Every unexplained journey</a> · `
        + `<a href="${esc(href('segments', 'verdict', 'all'))}">every segment</a>`);
  root.append(clear);

  /* ── the ladder, and who it names ───────────────────────────────────────
     Above the verdict donut and the vehicle bars, because an operator opening
     this page came for a person and those two answer about a category and a
     car. */
  if (att) {
    tierChips(root, att, { kind, value, tier, who });
    root.append(note(att.note, 'warn'));
    whoPanel(root, d.rows, { kind, value, tier, who }, !!d.truncated || !!att.truncated);
  }

  const g = el('div', 'grid g3'); root.append(g);

  // ── verdict, as the distribution AND as the filter ──────────────────────
  const vp = panel('What we decided', 'Every occupancy interval gets one. Click a slice to filter.');
  g.append(vp.panel);
  if (vf.length) {
    donut(vp.body, vf.map((r) => ({ label: r.key, n: r.n })), {
      onClick: (s) => { location.hash = href('segments', 'verdict', s.label); } });
    vp.body.append(el('div', 'chips', vf.map((r) =>
      `<a class="chip${kind === 'verdict' && value === r.key ? ' on' : ''}" href="${href('segments', 'verdict', r.key)}">`
      + `${esc(r.key)} <b>${fmt(r.n)}</b></a>`).join('')));
  } else empty(vp.body, 'Nothing reconciled in this range');

  // ── which cars, and who was holding them ────────────────────────────────
  const pp = panel('Vehicles with unexplained occupancy', 'Ranked by flags, not by fleet size');
  g.append(pp.panel);
  const plates = (d.facets.plate || []).filter((r) => r.unauthorized > 0);
  if (plates.length) {
    hbars(pp.body, plates.slice(0, 12).map((r) => ({ label: r.key, n: r.unauthorized })),
      { color: '--s8', onClick: (s) => { location.hash = href('segments', 'plate', s.label); } });
    /* The facet list is capped at the 40 busiest plates, so this count is over
       what came back. A truncated facet is not a shorter menu — the vehicle
       you are looking for is simply absent from it — so the page says how many
       there are rather than implying the list is all of them. */
    const ft = d.facet_totals || {};
    pp.body.append(el('p', 'cap',
      `${countOf(plates.length, 'vehicle')} shown ${plural(plates.length, 'carries', 'carry')} at least one `
      + 'flag. A bar is a link to that vehicle’s segments.'
      + (ft.plate > ft.plate_shown
        ? ` ${fmt(ft.plate)} vehicles appear in this range in total — open a vehicle directly if it is not listed.`
        : '')));
  } else empty(pp.body, 'No vehicle carries an unexplained segment in this range');

  // ── what the reconciler actually said ───────────────────────────────────
  const rp = panel('Recorded reasons', 'The reconciler’s own words, not a sentence written here');
  g.append(rp.panel);
  /* Folded to SHAPES. The facet counts every distinct string, and the strings
     embed a trip id and a minute count — so "matched uber trip fa66c89c-…" is
     109 different reasons and "telemetry clock is 2339 min behind wall time"
     is another four. Four shapes carry meaning and the panel reported 109.
     Folded here rather than only server-side, so this reads correctly whether
     or not the endpoint groups them. */
  const shapeOf = (k) => String(k)
    .replace(/\b[0-9a-f]{8}-?[0-9a-f-]{4,}\b/gi, '<id>')
    .replace(/\b\d[\d.,]*\b/g, '<n>');
  const folded = new Map();
  (d.facets.reason || []).forEach((r) => {
    const key = shapeOf(r.key);
    const cur = folded.get(key) || { key, verdict: r.verdict, n: 0, forms: 0, sample: r.key };
    cur.n += r.n; cur.forms += 1;
    folded.set(key, cur);
  });
  const reasons = [...folded.values()].sort((a, b) => b.n - a.n);
  if (reasons.length) {
    rp.body.append(tableFrom(reasons, [
      { label: 'Reason', key: 'key',
        render: (r) => `<span class="wrap" title="${esc(r.sample)}">${esc(r.key)}</span>`
          + (r.forms > 1
            ? `<span class="dim" title="the same reason with a different id or number in it"> · ${fmt(r.forms)} wordings</span>`
            : '') },
      { label: 'Verdict', key: 'verdict', render: (r) => vTag(r.verdict) },
      { label: 'Segments', key: 'n', num: true },
    ], { compact: true, sortable: true, sortId: 'reasons', defaultSort: { key: 'n', dir: 'desc' } }));
    const rt = d.facet_totals || {};
    rp.body.append(el('p', 'cap',
      `${countOf(reasons.length, 'distinct reason')}, with the trip ids and minute counts folded out — `
      + 'the same sentence with a different id in it is one reason, not two.'
      + (rt.reason > rt.reason_shown
        ? ` The server sent the ${fmt(rt.reason_shown)} commonest of ${fmt(rt.reason)} raw strings.`
        : '')));
    if (d.unreasoned) rp.body.append(el('p', 'cap',
      `${fmt(d.unreasoned)} of the segments matching this filter carry no recorded reason at all — `
      + 'they were judged by a version of the reconciler that did not write one down.'));
  } else empty(rp.body, 'No reasons recorded');

  // ── the day strip, as a filter ──────────────────────────────────────────
  if (days.length) {
    const dp = panel('By day', 'Unexplained intervals per day — click a day for that day’s list');
    root.append(dp.panel);
    const strip = el('div', 'cal');
    days.forEach((r) => {
      const c = el('i', r.unauthorized ? 'c bad' : 'c');
      c.style.opacity = r.unauthorized
        ? String(0.35 + 0.65 * Math.min(1, r.unauthorized / Math.max(1, ...days.map((x) => x.unauthorized))))
        : '0.18';
      c.title = `${r.key} — ${r.unauthorized} unexplained of ${r.n} segments`;
      c.style.cursor = 'pointer';
      c.onclick = () => { location.hash = href('segments', 'day', r.key); };
      strip.append(c);
    });
    dp.body.append(strip);
    dp.body.append(el('p', 'cap',
      `${dateStr(days[0].key)} → ${dateStr(days[days.length - 1].key)} · `
      + 'a pale cell is a day with occupancy but nothing unexplained.'));
  }

  // ── the list itself ─────────────────────────────────────────────────────
  /* The two attribution filters are applied HERE rather than at the endpoint.
     /api/segments knows nothing about tiers — the attribution is computed, not
     stored, and there is no index from a person to a segment because there
     cannot be one — so the narrowing happens over the rows on screen and the
     caption says so whenever the list is capped. A silent client-side filter
     over a truncated list is the shape of bug that reports a clean fleet. */
  const whoName = who && d.rows
    .flatMap((r) => (Array.isArray(r.attribution_candidates) ? r.attribution_candidates : []))
    .find((c) => c.key === who)?.name;
  const shown = d.rows.filter((r) => {
    if (tier && r.attribution_tier !== tier) return false;
    if (who && !asList(r.attribution_candidate_keys).includes(who)) return false;
    return true;
  });
  const narrowed = tier || who;
  if (narrowed) {
    const nb = el('div', 'note');
    nb.innerHTML = 'Narrowed to '
      + [tier ? `<b>${esc(TIER_LABEL[tier])}</b>` : null,
        who ? `journeys <b>${esc(whoName || 'this person')}</b> is a candidate for` : null]
        .filter(Boolean).join(' and ')
      + `. <a href="${esc(href('segments', kind, value))}">Show all of them</a>`;
    root.append(nb);
  }

  const lp = panel(
    defaulted ? 'Every unauthorized trip'
      : (k === 'verdict' && v === 'all' ? 'Every occupancy segment' : `Segments — ${k} ${v}`),
    /* NOT THE WORD "narrowed". This file uses it throughout to mean "attributed
       to one person" — the band's unit is "of N narrowed to one person", its
       meta says "not narrowed", and a KPI tile is headed "Cannot be narrowed".
       Used here for "a chip filter is on", #segments?tier=unknown read
       "1 of 10 narrowed shown": the page's own word for an attributed journey,
       describing the one journey that by definition could not be attributed to
       anybody, directly under a tile reading CANNOT BE NARROWED. */
    `${fmt(shown.length)}${narrowed
      ? ` of ${fmt(d.rows.length)} shown, filtered by ${[
        tier ? TIER_LABEL[tier].toLowerCase() : null,
        who ? 'person' : null].filter(Boolean).join(' and ')}`
      : ' shown'}`
    + `${d.truncated ? ` of ${fmt(d.total)}` : ''} · click a row for the evidence`);
  root.append(lp.panel);
  if (!shown.length) {
    /* "Nothing matches this filter" for a facet that came from this page's own
       chips is a dead end; naming the facet and offering the way back is not. */
    const box = el('div', 'empty');
    box.innerHTML = narrowed
      ? `<b>No journey on this list is ${esc(tier ? TIER_LABEL[tier].toLowerCase() : 'this person’s')}</b>`
        + 'The rung counts above are measured over the whole window; this list is capped and, if a '
        + 'vehicle or a day is also selected, narrowed twice.'
      : defaulted
        ? '<b>No unexplained journey in this window</b>Either nothing went unbooked, or the seat '
          + 'sensor recorded nothing at all here — the coverage line above says which, and the two '
          + 'are not the same finding.'
        : `<b>No segment with ${esc(k)} = ${esc(v)}</b>`
          + `The facet came from this window's own counts, so this usually means the filter has been `
          + 'narrowed twice — by the chip and by the date range above.';
    const back = el('p', 'cap');
    back.innerHTML = `<a class="lnk" href="${esc(href('segments'))}">Every unauthorized trip</a>`
      + ` · <a class="lnk" href="${esc(href('segments', 'verdict', 'all'))}">every segment</a>`;
    box.append(back);
    lp.body.innerHTML = ''; lp.body.append(box);
    return;
  }
  lp.body.append(segmentTable(shown));
  if (d.truncated) lp.body.append(el('p', 'cap',
    `Showing the ${fmt(d.rows.length)} most recent of ${fmt(d.total)}. Narrow by vehicle or day to see the rest — `
    + 'this list is capped rather than paged, so the tail is genuinely not on screen.'
    + (narrowed ? ' The rung and person filters above run over what is on screen, so they narrow '
      + 'that capped list rather than the whole window.' : '')));
  if (att?.truncated) lp.body.append(el('p', 'cap',
    `The attribution list itself is capped at ${fmt(att.limit)} of ${fmt(att.total)} unexplained `
    + 'journeys, so the oldest rows here keep the day-grain custody this column used to show, '
    + 'labelled as such. Narrow the date range to attribute them.'));
  /* The coverage sentence, but only in the one shape the day-strip caption
     above does not already cover: no seat-sensor evidence AT ALL, from any of
     the three sources. An empty list then means absent evidence rather than a
     clean fleet, and those two must never read alike — a window no provider
     watched (before CABMAN DT and FMS's live count were collected, and not yet
     judged from FMS journeys) lands here. */
  if (att && att.coverage?.days_with_data === 0 && att.coverage?.note) {
    root.append(note(att.coverage.note, 'warn'));
  }
}

/* A table of segments where every cell that names something is a link to it.
   Exported because the vehicle and day pages want the same table. */
/* WHERE A FLAGGED JOURNEY WENT, in the words the gazetteer learned.
   ──────────────────────────────────────────────────────────────────────────
   The table printed a plate, a clock time, a distance and a verdict, and the
   row it printed them from already held both endpoints as decimal pairs. An
   operator cannot tell a car repositioning to the airport from a car taken
   home to Sharjah without this, and "the most serious claim this product
   makes" — the sentence at the top of test/segment_routes.test.mjs — deserved
   better than 25.24687004.

   The vote count rides in the tooltip rather than the cell: a name four
   hundred trips agree on and a name one stray reverse-geocode supplied look
   identical on a table, and the difference matters exactly when somebody is
   about to act on it. A cell nothing ever named renders as unnamed with its
   coordinate, not as a blank and not as the nearest place we happen to hold. */
const placeCell = (place, lat, lng) => {
  if (place && place.area) {
    const votes = place.votes == null ? '' : ` \u00b7 ${fmt(place.votes)} of ${fmt(place.seen ?? place.votes)}`
      + ' trips here call it that';
    const thin = place.votes != null && place.votes < 5;
    /* Clipped to the width of a table cell, with the whole name in the title.
       "Al Quoz Industrial Area 3 → Jumeirah Lakes Towers" set to wrap turned
       every row three lines tall and halved how many an operator could scan;
       set to nowrap it pushed the verdict off the screen. The name a person
       recognises is in its first eighteen characters, and the detail page
       carries it in full in a sentence. */
    const short = place.area.length > 18 ? `${place.area.slice(0, 17)}\u2026` : place.area;
    return `<span class="${thin ? 'dim' : ''}" title="${esc(place.area
      + ` — from the fleet\u2019s own trip endpoints${votes}`)}">`
      + `${esc(short)}${thin ? ' <span class="dim">?</span>' : ''}</span>`;
  }
  if (lat == null || lng == null) return '<span class="ent-off" title="no position was recorded for this end">—</span>';
  return `<span class="ent-off" title="the fleet has never driven near enough to this spot to have a name for it">`
    + `${esc(Number(lat).toFixed(3))}, ${esc(Number(lng).toFixed(3))}</span>`;
};

/* AED, and never under the word cost. It is the revenue those kilometres
   would have earned had they been sold; the fuel and wear behind them is a
   different, smaller number nothing here measures. The rate is on the row so
   the tooltip can state it — a money figure whose rate is unstated is what
   this product spent a month removing from its money pages. */
const forgoneCell = (r) => (r.forgone_aed == null
  ? `<span class="ent-off" title="${esc(r.rate_basis || 'no distance was measured across this interval')}">—</span>`
  : `<span title="${esc(r.rate_basis || '')}">${money(r.forgone_aed)}</span>`);

export function segmentTable(rows, opts = {}) {
  if (!rows.length) { const d = el('div'); empty(d, opts.emptyMsg || 'Nothing flagged here'); return d; }
  const anyReason = rows.some((r) => r.verdict_reason);
  const anyFleet = rows.some((r) => r.fleet_id);
  const anyFix = rows.some((r) => r.fixes != null || r.max_gap_min != null || r.ignition_ratio != null);
  /* Both columns are conditional for the same reason every other one here is:
     a caller that does not select them gets a table without them rather than a
     column of dashes claiming the data does not exist. */
  const anyPlace = rows.some((r) => r.start_place || r.end_place || r.start_lat != null);
  const anyValue = rows.some((r) => r.forgone_aed != null);
  /* Conditional for the same reason every other column here is, and the
     condition is the caller's data rather than a flag: a caller that has not
     merged /api/unauthorized/attributed onto its rows keeps the day-grain
     custody column unchanged, which is what api/public/vehicle.js and
     api/public/day.js pass. The day the ladder reaches them, their tables gain
     the narrower column without either file being edited. */
  const anyAtt = rows.some((r) => r.attribution_tier);
  const t = tableFrom(rows, [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* WHICH PROVIDER SAW IT. CABMAN DT, FMS's live seat count or an FMS
       journey — and from 2026-09-23 one ride on an FMS car is normally two
       rows here, its live-count segment and its journey, each with its own
       times. The passenger count rides along where the provider reported one
       (an FMS journey's Seat Count). */
    { label: 'Provider', key: 'source',
      render: (r) => `${esc(segSourceLabel(r))}${r.passengers != null
        ? `<span class="dim" title="the passenger count the provider reported"> · ${fmt(r.passengers)} aboard</span>` : ''}` },
    ...(anyFleet ? [{ label: 'Fleet', key: 'fleet_id',
      render: (r) => (r.fleet_id ? pill(sourceLabel(r.fleet_id), 'plat') : '—') }] : []),
    /* Both destinations, because they answer different questions and the row
       previously offered only one. The name opens the PERSON — which is what
       somebody reading an accusation wants — and the funnel opens this
       driver's other flagged segments. A handover day names two people and
       both are openable, which is why the endpoint returns name-and-id pairs
       rather than a comma-joined string it could only print. */
    /* "Driver that day" is honest and is not enough. Day custody names two
       people on a handover day for one journey that had one driver, and an
       operator holding two names has an accusation nobody can act on. Where an
       attribution exists the heading becomes WHO THE EVIDENCE NAMES and the
       tier rides in front of the name; where none exists the old column stands
       unchanged, so this table cannot silently upgrade a custody record into a
       narrowed one. */
    (anyAtt
      ? { label: 'Who the evidence names', key: 'attribution_tier', render: attributionCell }
      : { label: 'Driver that day', key: 'drivers',
        render: (r) => custody(r, { title: 'This driver’s other flagged segments',
          hrefFor: (d) => href('segments', 'driver', d.name) }) }),
    /* The provider's own timestamps, start and end: two providers' readings
       of one ride start and end at different moments, and the reader has to
       see both to see they are one ride. */
    { label: 'Started', key: 'started_at',
      render: (r) => `<a href="${segHref(r)}">${esc(`${dateStr(r.started_at)} ${timeStr(r.started_at)}`)}</a>`
        + (r.ended_at ? `<span class="dim"> → ${esc(timeStr(r.ended_at))}</span>` : '') },
    { label: 'Duration', key: 'duration_min', num: true, render: (r) => (r.duration_min ?? '—') + ' min' },
    /* Null is not zero. A segment with no measured distance printed "0 km",
       which is a claim that the vehicle did not move — the opposite of what an
       unexplained occupancy means. */
    { label: 'Distance', key: 'distance_km', num: true,
      render: (r) => (r.distance_km == null
        ? '<span class="ent-off" title="no distance was measured across this interval">—</span>'
        : `${fmt(r.distance_km, 1)} km`) },
    /* Both ends, in one column and in reading order. Two columns would have
       pushed the verdict off a laptop screen; the arrow is what makes it one
       fact rather than two. */
    ...(anyPlace ? [{ label: 'From \u2192 to', key: 'start_place',
      render: (r) => '<span style="white-space:nowrap">'
        + `${placeCell(r.start_place, r.start_lat, r.start_lng)}`
        + '<span class="dim"> \u2192 </span>'
        + `${placeCell(r.end_place, r.end_lat, r.end_lng)}</span>` }] : []),
    /* What the distance was worth, beside the distance. An unexplained
       journey measured in kilometres is a statistic; the same journey in
       dirhams is a conversation, which is the whole reason this column was
       asked for. */
    ...(anyValue ? [{ label: 'Forgone', key: 'forgone_aed', num: true, render: forgoneCell }] : []),
    /* An FMS journey carries its distance and duration and nothing sampled —
       no top speed, no fixes, no ignition ratio — and says so rather than
       leaving a bare dash. */
    { label: 'Top speed', key: 'top_speed', num: true,
      render: (r) => (r.top_speed == null
        ? `<span class="ent-off" title="${r.source === 'fms_trip'
          ? 'an FMS journey carries no top speed — only its distance and duration'
          : 'no speed was recorded across this interval'}">—</span>`
        : `${fmt(r.top_speed)} km/h`) },
    ...(anyFix ? [{ label: 'Fixes', key: 'fixes', num: true,
      render: (r) => (r.fixes == null
        ? (r.source === 'fms_trip'
          ? '<span class="ent-off" title="an FMS journey is the provider’s own record of the trip, not built from fixes">—</span>'
          : '—')
        : `${fmt(r.fixes)}${r.max_gap_min ? `<span class="dim" title="largest gap between consecutive fixes"> · gap ${fmt(r.max_gap_min)}m</span>` : ''}`) },
    { label: 'Ignition on', key: 'ignition_ratio', num: true,
      render: (r) => (r.ignition_ratio == null
        ? `<span class="ent-off" title="${r.source === 'fms_trip'
          ? 'an FMS journey carries no ignition samples to take a ratio of'
          : 'this feed does not report ignition'}">—</span>`
        : `${fmt(r.ignition_ratio * 100, 0)}%`) }] : []),
    { label: 'Verdict', key: 'verdict', render: (r) => vTag(r.verdict) },
    /* The reason the reconciler recorded. It is the field that makes a verdict
       readable, it is on every row, and the list showed only the verdict —
       so the most serious claim this product makes arrived with no working. */
    ...(anyReason ? [{ label: 'Why', key: 'verdict_reason',
      render: (r) => (r.verdict_reason
        ? `<span class="wrap dim" title="${esc(r.verdict_reason)}">${esc(String(r.verdict_reason).slice(0, 80))}${
          String(r.verdict_reason).length > 80 ? '…' : ''}</span>`
        : '<span class="ent-off" title="judged by a version of the reconciler that did not record one">none recorded</span>') }] : []),
    { label: 'Confidence', key: 'low_confidence',
      render: (r) => {
        if (!r.low_confidence) return '<span class="tag dim">ok</span>';
        const out = asList(r.unavailable_sources).map(sourceLabel);
        return `<span class="tag warn" title="${esc(out.length
          ? `unreadable when this was judged: ${out.join(', ')}`
          : 'a revenue channel was unreadable when this was judged')}">blind${
          out.length ? ` · ${esc(out.join(', '))}` : ''}</span>`;
      } },
  ], { sortable: true, sortId: opts.sortId || 'segs', defaultSort: { key: 'started_at', dir: 'desc' },
    // The row is a link too, bound through onRow so re-sorting cannot open the
    // wrong segment; a click on a cell link is left to that link.
    onRow: (r) => { location.hash = segHref(r); } });
  return t;
}

/* ── one interval, with the case for and against ──────────────────────────── */
export async function renderSegment(root, plate, at) {
  root.innerHTML = '';
  /* Addressed with no id — a typed URL, a stale bookmark, a link whose id
     never got filled in. It went to the endpoint and printed the API's own
     complaint. #day has always answered this properly; these four did not. */
  if (!plate || !at) return noneChosen(root, 'segment', 'segments', 'Every occupancy segment');
  loading(root);
  /* The provider rides in the address (?source=), because a segment is
     (source, plate, started_at) now. An address from before carries none and
     still opens: the server answers with the first provider holding a segment
     at that instant and names any other in other_sources. */
  const askSource = hashQ('source');
  let d;
  try {
    d = await api(`/api/segment?plate=${encodeURIComponent(plate)}&at=${encodeURIComponent(at)}`
      + (askSource ? `&source=${encodeURIComponent(askSource)}` : ''));
  } catch (e) {
    root.innerHTML = '';
    return empty(root, `No segment starts at that instant for ${esc(plate)}. `
      + 'The address encodes an exact timestamp, so a re-reconciliation that shifted a boundary breaks the link.');
  }
  root.innerHTML = '';
  const s = d.segment;

  /* WHICH PROVIDER THIS IS, AND ITS OWN TIMES — before any verdict is read.
     From 2026-09-23 one ride on an FMS car is normally two segments, FMS's
     live count and FMS's journey, and on the two cars with both trackers a
     CABMAN one too; each is a separate reading with its own start and end.
     The others on this car that day are in the table at the foot of the page. */
  const prov = el('p', 'note');
  prov.innerHTML = `Seen by <b>${esc(segSourceLabel(s))}</b>, from `
    + `${esc(`${dateStr(s.started_at)} ${timeStr(s.started_at)}`)} to `
    + `${s.ended_at ? esc(`${dateStr(s.ended_at)} ${timeStr(s.ended_at)}`) : '<span class="dim">no recorded end</span>'}`
    + (s.passengers != null ? ` · ${fmt(s.passengers)} ${plural(s.passengers, 'passenger')} by the provider’s count` : '')
    + '.'
    + ((d.other_sources || []).length
      ? ` ${esc((d.other_sources || []).map((o) => o.source_label || o.source).join(' and '))} also `
        + 'recorded a segment starting at this same instant on this car — '
        + (d.other_sources || []).map((o) => `<a href="${href('segment', plate, s.started_at, { source: o.source })}">`
          + `open ${esc(o.source_label || o.source)}’s</a>`).join(' · ') + '.'
      : '');
  root.append(prov);

  root.append(kpiRow([
    { label: 'Verdict', value: s.verdict || '—', tone: VERDICT_TONE[s.verdict] || null,
      sub: s.matched_platform ? `matched on ${s.matched_platform}` : 'no booking matched' },
    { label: 'Duration', value: (s.duration_min ?? '—') + ' min', sub: `${timeStr(s.started_at)} → ${timeStr(s.ended_at)}` },
    /* Null is not zero, here as everywhere else in this file: `?? 0` printed
       "0 km" over a journey whose distance nobody measured, which is a claim
       that the vehicle did not move — the opposite of what an unexplained
       occupancy means. */
    { label: 'Distance', value: s.distance_km == null ? '—' : `${fmt(s.distance_km, 1)} km`,
      sub: s.distance_km == null ? 'no distance was measured across this interval'
        : d.profile.max_speed != null ? `peak ${Math.round(d.profile.max_speed)} km/h` : 'no speed recorded' },
    /* WHAT IT WAS WORTH. The operator's own words for why this tile exists:
       "how much (average AED/km multiplied by distance) that costed the
       company for being unauthorized". The product is worth having; the word
       cost is not right for it, so the tile says forgone and the sub-line
       names the rate and the population behind it. */
    { label: 'Revenue forgone', tone: d.value?.forgone_aed ? 'bad' : null,
      value: d.value?.forgone_aed == null ? '—' : money(d.value.forgone_aed),
      sub: d.value?.basis || 'not valued' },
    { label: 'Observed', value: s.source === 'fms_trip' ? 'whole journey'
      : d.profile.observed === null ? '—' : d.profile.observed ? 'fully' : 'with a gap',
      sub: s.source === 'fms_trip'
        ? 'an FMS journey is the provider’s own record of the trip, start to end — it has no sampling gap'
        : s.max_gap_min != null ? `largest gap ${s.max_gap_min} min` : 'gap not recorded',
      tone: d.profile.observed === false && s.source !== 'fms_trip' ? 'warn' : null },
  ]));

  /* WHERE IT WENT, stated before the evidence rather than left on a map the
     reader has to scroll to. Both ends named out of the fleet's own gazetteer
     (api/place_sql.js), with the coordinate kept beside the name so a reader
     who wants to check it can. */
  if (s.start_lat != null || s.end_lat != null) {
    const where = el('p', 'note');
    const end = (place, lat, lng) => (place?.area
      ? `<b>${esc(place.area)}</b>${place.votes != null && place.votes < 5
        ? ' <span class="dim">(named by only ' + fmt(place.votes) + ' trips here)</span>' : ''}`
      : lat == null ? '<span class="dim">an unrecorded position</span>'
        : `<span class="dim">${esc(Number(lat).toFixed(4))}, ${esc(Number(lng).toFixed(4))} — `
          + 'ground the fleet has never driven near enough to name</span>');
    where.innerHTML = `Started in ${end(s.start_place, s.start_lat, s.start_lng)}`
      + ` and ended in ${end(s.end_place, s.end_lat, s.end_lng)}.`
      + (s.distance_km != null && d.value?.aed_per_km
        ? ` The ${fmt(s.distance_km, 1)} km between them would have earned `
          + `<b>${money(d.value.forgone_aed)}</b> at the fleet\u2019s own `
          + `${money(d.value.aed_per_km)}/km. Revenue forgone, not a cash cost \u2014 `
          + 'the fuel and wear behind those kilometres is a different, smaller number.'
        : '');
    root.append(where);
  }

  /* ── WHO THE EVIDENCE NAMES, ON THE PAGE THE ROW OPENS ─────────────────
     THE DEFECT THIS ANSWERS. Every row on both new surfaces opens this page,
     and the copy in three separate places calls it the one "where the case for
     and against it is argued in full" and says "a name on this page that leads
     nowhere is a name nobody can check". This page carried NO attribution at
     all. Its header printed `held that day by <b>${s.drivers}</b>` — the raw
     comma-joined day-grain custody string, flatly, with no tier, no evidence
     sentence and no hedge. So the bracketed row that reads "NAMED BY TIME ·
     Zain … · −54m/+75m" on the list opened a page whose first line was
     "L45243 — held that day by Waseem Abbas Ghulam Nabi, Zain Hassan Raja
     Nasrullah Khan": the narrowing the whole feature exists to perform, undone
     at the exact moment of verification. In the other direction an ambiguous
     row whose list cell says "none is chosen" opened a page reading as a joint
     accusation against both.

     So the attribution is fetched for this one segment and rendered ABOVE the
     custody line, and the custody line itself now says what grain it is. */
  let att = null;
  if (s.verdict === 'unauthorized') {
    const day = String(s.local_day);
    const raw = await qAll('/api/unauthorized/attributed',
      { verdict: 'unauthorized', limit: 500, from: day, to: day }).catch(() => null);
    const rows = raw && raw.distribution ? (raw.rows || []) : [];
    att = rows.find((r) => r.plate === plate && (r.source || 'cabman') === (s.source || 'cabman')
      && Date.parse(r.started_at) === Date.parse(s.started_at)) || null;
    const box = el('div', 'note' + (att ? '' : ' warn'));
    box.innerHTML = att
      ? `<b>Who the evidence names — ${esc(TIER_LABEL[att.attribution_tier]
        || att.attribution_tier || 'no rung reached')}</b><br>`
        + ((att.attribution_candidates || []).length
          ? (att.attribution_candidates || []).map((c) => entity('driver', c.id, c.name))
            .join(att.attribution_tier === 'ambiguous'
              ? '<span class="dim"> or </span>' : ', ')
          : '<span class="ent-off">nobody can be named</span>')
        + `<br><span class="wrap">${esc(att.attribution_evidence || '')}</span>`
        + (att.status_note ? `<br><span class="wrap dim">${esc(att.status_note)}</span>` : '')
        + '<br><span class="dim">Every name here is an INFERENCE. An unexplained journey is by '
        + 'definition one no booking explains, so no booking names its driver — the rung above '
        + 'says which rule produced this name and the sentence states the measurement that '
        + 'rule ran, so it can be checked against this car’s own trip list below.</span>'
      : 'The attribution for this journey could not be loaded, so this page shows day-grain '
        + 'custody only. That is a failure of the request, not a finding about anybody.';
    root.append(box);
  }

  const head = el('div', 'note');
  head.innerHTML = `<b>${esc(plate)}</b> — ${entity('vehicle', plate, 'vehicle page')} · `
    /* DAY GRAIN, AND IT SAYS SO. This read "held that day by X, Y" with no
       qualifier, which is a narrowed name's voice describing a custody record.
       A handover day names two people for one journey that had one driver. */
    + (s.drivers
      ? 'custody that day <span class="dim">(day grain — this is who HELD the car, not a '
        + `narrowed name)</span>: <b>${esc(s.drivers)}</b>`
      : 'no driver could be attributed to this vehicle on this day')
    + ` · <a href="${href('day', s.local_day)}">everything that happened on ${esc(s.local_day)}</a>`
    + ` · <a href="${href('segments', 'plate', plate)}">this vehicle’s other segments</a>`;
  root.append(head);

  /* ── why ──────────────────────────────────────────────────────────────── */
  const why = panel('Why this verdict', 'What the reconciler recorded, and what it could read at the time');
  root.append(why.panel);
  why.body.append(el('p', 'note', VERDICT_MEANS[s.verdict] || 'This verdict has no written meaning.'));
  const facts = [];
  if (s.verdict_reason) facts.push(['Recorded reason', esc(s.verdict_reason)]);
  else facts.push(['Recorded reason', '<span class="dim">none — judged before reasons were written down</span>']);
  if (s.channels_checked) facts.push(['Channels checked', esc(s.channels_checked)]);
  if (s.nearest_platform || s.nearest_trip_id) {
    facts.push(['Nearest booking', `${esc(s.nearest_platform || '—')} ${esc(s.nearest_trip_id || '')}`
      + (s.nearest_gap_min != null ? ` — ${s.nearest_gap_min} min away` : '')]);
  }
  if (s.boundary_gap_min != null) facts.push(['Nearest telemetry boundary', `${s.boundary_gap_min} min`]);
  if (s.ignition_ratio != null) facts.push(['Ignition on', Math.round(s.ignition_ratio * 100) + '% of fixes']);
  facts.push(['Fixes stored', `${fmt(d.profile.fixes)}${d.profile.moving_pct != null ? ` · moving in ${d.profile.moving_pct}%` : ''}`]);
  why.body.append(tableFrom(facts.map(([k, v]) => ({ k, v })), [
    { label: 'Evidence', key: 'k' }, { label: '', key: 'v', render: (r) => r.v },
  ], { compact: true }));

  if (s.low_confidence) {
    why.body.append(el('p', 'note err',
      `Assessed while these sources were unavailable: ${esc(s.unavailable_sources || 'unrecorded')}. `
      + 'A booking may exist that we could not read, so "no booking anywhere" is a statement about our collection, not about the driver.'));
  }

  /* A clock skew is only visible in the neighbours. If every nearby booking
     sits at the same offset, the fleet is not stealing cars — a timestamp is
     wrong somewhere. */
  const g2 = el('div', 'grid g2'); root.append(g2);
  const nv = panel('Bookings on this vehicle, ±4 hours',
    'Not just the nearest — and deliberately wider than the reconciler’s own match window, because the '
    + 'documented skew is four hours and a window narrower than the bug cannot show the bug');
  g2.append(nv.panel);
  if (d.nearby_vehicle_trips.length) {
    nv.body.append(tableFrom(d.nearby_vehicle_trips, [
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Requested', key: 'requested_at', render: (r) => timeStr(r.requested_at) },
      { label: 'Offset', key: 'gap_min', num: true, render: (r) => (r.gap_min > 0 ? '+' : '') + r.gap_min + ' min' },
      { label: 'Outcome', key: 'outcome', render: (r) => (r.outcome
        ? `<span class="tag ${r.outcome === 'completed' ? 'ok' : 'warn'}">${esc(r.outcome)}</span>`
        : `<span class="tag dim">${esc(r.status || '—')}</span>`) },
      { label: 'Fare', key: 'price', num: true,
        absent: `none of the bookings around this interval carries a fare — ${UBER_FARE_WHY}`,
        render: (r) => (r.price != null ? money(r.price) : '—') },
    ], { compact: true }));
    const offs = d.nearby_vehicle_trips.map((r) => r.gap_min).filter((n) => n != null);
    const spread = offs.length > 1 ? Math.max(...offs) - Math.min(...offs) : null;
    if (offs.length > 2 && spread != null && spread < 5) {
      nv.body.append(el('p', 'note err',
        `Every nearby booking sits within ${spread} minutes of the same offset. That is the signature of a clock `
        + 'skew between the telemetry feed and the booking channel, not of an unbooked ride.'));
    }
  } else {
    empty(nv.body, 'No booking on any collected channel touched this vehicle within four hours either side');
  }

  const nd = panel('Bookings by the driver who held this car, ±90 min',
    'A person demonstrably driving something else did not drive this');
  g2.append(nd.panel);
  if (d.nearby_driver_trips.length) {
    nd.body.append(tableFrom(d.nearby_driver_trips, [
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Requested', key: 'requested_at', render: (r) => timeStr(r.requested_at) },
      { label: 'Offset', key: 'gap_min', num: true, render: (r) => (r.gap_min > 0 ? '+' : '') + r.gap_min + ' min' },
      { label: 'Outcome', key: 'outcome', render: (r) => esc(r.outcome || r.status || '—') },
    ], { compact: true }));
    const elsewhere = d.nearby_driver_trips.filter((r) => r.plate && r.plate !== plate);
    /* PLURAL-SAFE. This said "the person named above was not behind this
       wheel" in the singular while the line above it names every custodian of
       a handover day — two people, and the sentence picked one of them by
       grammar. */
    const held = String(s.drivers || '').split(',').filter((x) => x.trim()).length;
    if (elsewhere.length) nd.body.append(el('p', 'note err',
      `${fmt(elsewhere.length)} of these bookings were taken in a different vehicle. Either the custody `
      + 'attribution for this day is wrong, or '
      + (held > 1
        ? `at least one of the ${fmt(held)} people named above was not behind this wheel — and `
          + 'this page does not say which, because nothing in the record does.'
        : 'the person named above was not behind this wheel.')));
  } else if (!s.drivers) {
    empty(nd.body, 'No driver is attributed to this vehicle on this day, so there is nobody to check');
  } else {
    empty(nd.body, 'That driver has no booking on any channel within 90 minutes either side');
  }

  /* ── the fixes ────────────────────────────────────────────────────────── */
  /* This provider's own fixes: CABMAN DT's for a CABMAN segment, FMS's for
     either FMS source. On the two cars with both trackers the devices report
     different positions, so the track never mixes them. */
  const tp = panel('Telemetry through the window',
    s.source === 'cabman' || !s.source
      ? `${fmt(d.track.length)} CABMAN DT fixes at 5-minute resolution, five minutes either side of the boundary`
      : `${fmt(d.track.length)} FMS fixes, about six minutes apart, five minutes either side of the boundary`
        + (s.source === 'fms_trip' ? ' — the journey itself is FMS’s record; these are the positions around it' : ''));
  root.append(tp.panel);
  if (d.track.length) {
    areaChart(tp.body, d.track.map((r) => ({ t: timeStr(r.captured_at), speed: +r.speed || 0 })),
      { x: 't', y: 'speed', color: '--s8' });
    tp.body.append(tableFrom(d.track.slice(0, 60), [
      { label: 'Time', key: 'captured_at', render: (r) => timeStr(r.captured_at) },
      trackerState, trackerSpeed,
      /* CABMAN DT's pad reading, or FMS's live seat count (occupied at 1 or
         more, the count itself beside it). An FMS fix from before the live
         count was collected (2026-09-23) carries none. */
      { label: 'Seat', key: 'seat_occupied', render: (r) => {
        if (r.source === 'fms') {
          return r.seat_count == null
            ? '<span class="tag dim" title="FMS’s live seat count was not reported on this fix">not reported</span>'
            : Number(r.seat_count) >= 1 ? `<span class="tag ok">occupied · ${fmt(r.seat_count)}</span>`
              : '<span class="tag">empty · 0</span>';
        }
        return r.seat_occupied == null
          ? '<span class="tag dim">not reported</span>'
          : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>';
      } },
      { label: 'Ignition', key: 'ignition', render: (r) => (r.ignition == null ? '—' : r.ignition ? 'on' : 'off') },
      { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true },
    ], { compact: true }));
    const sn = stillNote(d.track.slice(0, 60));
    if (sn) tp.body.append(sn);
    if (d.track.length > 60) tp.body.append(el('p', 'cap', `First 60 of ${fmt(d.track.length)} fixes.`));
  } else {
    empty(tp.body, 'No fixes are stored for this window — which means the segment itself was built from data we no longer hold');
  }

  /* ── the day around it ────────────────────────────────────────────────── */
  if (d.same_day_segments.length > 1) {
    const sd = panel(`Everything this vehicle did on ${s.local_day}`,
      `${fmt(d.same_day_segments.length)} occupancy intervals, every provider’s — one flag in a normal day `
      + 'reads differently from one in a day of flags, and two providers’ readings of one ride sit side by side');
    root.append(sd.panel);
    sd.body.append(segmentTable(d.same_day_segments.map((r) => ({ ...r, drivers: s.drivers }))));
  }

  if (d.custody.length) {
    const cp = panel('Custody either side of this day', 'Who the trip record says was in this car');
    root.append(cp.panel);
    cp.body.append(tableFrom(d.custody, [
      { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Trips', key: 'trips', num: true },
    ], { compact: true }));
  }

  if (d.channels_that_day.length) {
    const ch = panel('Channels that wrote rows that day',
      'A verdict of “no booking anywhere” means nothing if a channel was not collecting');
    root.append(ch.panel);
    ch.body.append(el('div', 'chips', d.channels_that_day.map((r) =>
      `<span class="chip">${esc(r.platform)} <b>${fmt(r.rows_that_day)}</b></span>`).join('')));
    ch.body.append(el('p', 'cap',
      'Counts are fleet-wide for that calendar day, not for this vehicle — a channel with zero rows fleet-wide '
      + 'was not collecting, and could not have supplied the missing booking.'));
  }
}
