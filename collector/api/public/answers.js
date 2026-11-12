/* ══ THE ANSWER LINE AND THE ACT-ON STRIP — the rules, one per page ═══════════
   The second half of FOCUS (HANDOFF 0.9; docs/AUDIT.md "Verbosity"; FIX-STATUS
   ANS, where every rule below is written out for the operator to review). The
   component that draws the result is answerline.js; this file decides every
   word of it.

   WHAT A RULE IS. A pure function of the data the page has ALREADY fetched —
   the page calls answer(view, key, data) at the point where that data is in
   hand, so a rule can never cause a request (the page's request count is
   unchanged; test/answers.test.mjs reads every page's hook for it). It returns
   either

     { text, basis, acts: [{ text, href, to }], none }   the page's answer, or
     { absent, basis, acts }                             why there is none.

   THE RULES EVERY RULE KEEPS (the task as set, 2026-11-12):
     · ONE line — a sentence answering the page's own question, with the
       figure that decides it, in the house's formatting (money to the fils,
       counts with separators, a true minus);
     · it states its BASIS — what it was computed from, and over what window;
     · when it cannot be computed it is ABSENT, with the TRUE reason: the
       server's own sentence where the server gave one (`why`, `absent`,
       `uncovered.reason`), the page's own failure sentence where the call
       failed — never a guess, and never a zero standing in for an unknown;
     · an ACT is something to do, not a restatement: at most three, ranked,
       each a link to where it is done — another page, a cohort list
       (#cohort/<key>, the same predicate the page's tile uses), or a panel
       further down this page (`to`: the panel's key, ui.js panel()'s
       data-panel, or its heading; answerline.js findTarget);
     · when nothing fired, `none` says what was checked, so "nothing to act on"
       is a finding with a basis, not a blank.

   AND ONE THE CODE ENFORCES. answerFor() refuses any sentence carrying NaN,
   undefined, null, Infinity or [object …] and draws the answer absent instead
   ("a figure it needs is missing") — the class of defect the verdict band's
   first version shipped (verdicts.js header: a 0% leader computed every load
   from the wrong field name, and a true but wrong sentence on screen). A rule
   that throws is drawn absent with the error, not swallowed.

   Where a page already computes something with care — the placeholder licence
   date on #drivers, the collection debt on #sources, which surfaces answered
   on #providers — the page hands the rule its own result rather than the rule
   recomputing it, so the answer and the page cannot disagree. Where the logic
   is shared and pure (verdicts.js fleetVerdict, cohorts.js membersOf) the rule
   calls the same function the page calls. */
import { fmt, money, countOf, plural, pct, dayStr, dateStr, dtStr, sourceLabel, contract } from './ui.js';
import { href, windowLabel, dayLabel, periodLabel, state } from './data.js';
import { fleetVerdict, revenueVerdict } from './verdicts.js';
import { membersOf } from './cohorts.js';
import { mountAnswer, ACTS_MAX } from './answerline.js';

/* ── small, shared ───────────────────────────────────────────────────────── */
/* A finite number, or null. Postgres sends numerics as strings; '' and null
   are not zero (ui.js fmt's own rule). */
export const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const abs = (v) => (num(v) == null ? null : Math.abs(Number(v)));
const absent = (reason, more = {}) => ({ absent: reason, ...more });
const act = (text, link, to = null) => ({ text, href: link, ...(to ? { to } : {}) });
/* A sentence's first letter up. */
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/* The page's own failure sentence, for a call that threw. */
const failed = (what, e) => `${what} could not be read: ${e?.message || 'no answer'}.`;
const ended = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/* The window, as a phrase inside a sentence: "this month", "in the last 30
   days", "in August 2026", "in 3 Aug 2026 – 19 Aug 2026" (data.js windowLabel
   is written as a heading). */
export function winPhrase(label) {
  const s = String(label || '').trim();
  if (!s) return '';
  if (/^(Today|Yesterday|This |Last (week|month)$)/.test(s)) return s[0].toLowerCase() + s.slice(1);
  if (/^Last \d/.test(s)) return `in the ${s[0].toLowerCase()}${s.slice(1)}`;
  return `in ${s}`;
}

/* The channel and fleet chips, as words for a basis — "every channel, both
   fleets", "Uber only, Ecosine only". Only for a page whose requests carry the
   chips (data.js q / qChan); a page that asks qAll() or bare api() covers
   every channel whatever the chips say, and its basis says so instead. */
export function scopeWords(ctx = {}) {
  return `${ctx.platform ? `${sourceLabel(ctx.platform)} only` : 'every channel'}, `
    + `${ctx.fleet ? `${sourceLabel(ctx.fleet)} only` : 'both fleets'}`;
}

/* ── the figures in a sentence: strict ──────────────────────────────────────
   ui.js's formatters print an unread figure as "—", which is right in a
   table cell and wrong in a sentence: "— of 330 drivers" reads as a figure,
   and no pattern can tell that dash from the house's own punctuation dash.
   So inside a rule every figure goes through one of these, which REFUSE a
   value that is not a number, and answerFor() turns the refusal into the
   absent line "a figure it needs is missing" — never a dash, never a zero. */
class Missing extends Error {}
const strict = (fn) => (v, ...rest) => {
  if (num(v) == null) throw new Missing('a figure it needs is missing from this page’s data');
  return fn(v, ...rest);
};
const F = strict(fmt);
const M = strict(money);
const C = strict(countOf);
const P = strict(pct);

/* ═══ THE RULES ═════════════════════════════════════════════════════════════
   Keyed by the page's address (#target → 'target'). Each takes (data, ctx):
   ctx = { win: the window label, platform, fleet: the chips, href, now }. The wording is the operator's to
   review (FIX-STATUS ANS lists every template and the field behind each slot),
   and follows the demo the operator saw on 2026-10-22 wherever the live data
   supports the same sentence. */
export const RULES = {
  /* #target — "Are we on target this month, and what does today ask?"
     data: { t: /api/target, h: /api/target/hours, live: today's live strip } */
  target({ t, h } = {}, ctx) {
    if (!t || t._err) return absent(failed('The month', t?._err));
    const s = t.summary;
    const month = t.month_name || 'This month';
    if (!s) return absent(t.why || `No target is set for ${month}.`);
    const days = Array.isArray(t.days) ? t.days : [];
    const past = days.filter((d) => d.state === 'past');
    const basis = 'Basis: the month’s plan against gross fares before platform commission, both fleets; '
      + 'a past day is called over or under once it has settled.';
    let text;
    if (s.met) {
      text = `${month}’s target is met: ${M(s.earned)} earned against ${M(s.month_target)}.`;
    } else if (!past.length) {
      if (num(s.today_needs) == null) return absent(`Nothing of ${month} has finished yet, and today’s share could not be read.`);
      text = `${month} has just begun: today asks ${M(s.today_needs)} in gross fares, and nothing is judged until tomorrow.`;
    } else {
      if (num(s.ahead) == null) return absent(`${month}’s plan to date could not be read.`);
      const unsettled = num(s.unsettled) || 0;
      text = `${month} so far: both fleets ${M(abs(s.ahead))} ${s.ahead >= 0 ? 'ahead of' : 'behind'} plan in gross fares, `
        + `${F(num(s.under) || 0)} of ${C(past.length, 'day')} under`
        + (unsettled ? ` and ${F(unsettled)} not settled yet` : '')
        + (num(s.today_needs) != null ? `; today asks ${M(s.today_needs)}.` : '.');
    }
    const acts = [];
    const R = h && !h._err ? h.revenue || {} : null;
    const P = h && !h._err ? h.trips || {} : null;
    const trips = (v) => C(Math.round(v), 'trip');
    if (R && !R.absent && num(R.ahead) != null && R.ahead < 0 && !s.met) {
      acts.push(act(`Right now ${R.estimate ? '≈ ' : ''}${M(-R.ahead)}`
        + (P && !P.absent && num(P.ahead) != null && P.ahead < 0 ? ` and ${trips(-P.ahead)}` : '')
        + ` behind the usual day at ${h.clock}`, ctx.href('target'), 'tp-today'));
    }
    const th = R && !R.absent ? R.this_hour || null : null;
    const need = th ? num(th.catch_up ?? th.need) : null;
    if (th && need != null && need > 0 && !s.met) {
      const pth = P && !P.absent ? P.this_hour || null : null;
      const pneed = pth ? num(pth.catch_up ?? pth.need) : null;
      acts.push(act(`This hour (${th.label}) must bring ${M(need)}`
        + (pneed != null && pneed > 0 ? ` and ${trips(pneed)}` : '') + ' to land the day', ctx.href('target'), 'tp-rev'));
    }
    const y = t.yesterday;
    if (y && y.verdict === 'under' && num(y.diff) != null && y.day) {
      acts.push(act(`Yesterday, ${y.label}, came in ${M(-y.diff)} under its target — open the day`, ctx.href('day', y.day)));
    }
    if (y && num(y.drove) && num(y.reached) != null && y.drove > y.reached) {
      acts.push(act(`${F(y.drove - y.reached)} of the ${F(y.drove)} who drove yesterday did under `
        + `${C(y.trips_min ?? t.trips_min, 'trip')} — see who is behind this month`, ctx.href('month-target')));
    }
    return { text, basis, acts,
      none: 'Nothing to act on: today is not behind the usual day, and yesterday met its target.' };
  },

  /* #overview — "How much work did the fleet do, and where did it come from?"
     data: { k: /api/kpis, daily: /api/trips/daily, byPlat: /api/mix?by=platform,
             cmp: /api/compare/period or null } */
  overview({ k, daily = [], byPlat = [], cmp = null } = {}, ctx) {
    if (!k) return absent('The booking counts did not load.');
    const trips = num(k.trips);
    if (trips == null) return absent('The booking count for this window could not be read.');
    const v = fleetVerdict({ kpis: k, daily, byPlatform: byPlat });
    const ch = num(cmp?.change_pct?.trips);
    const prev = cmp?.previous ? `${dayLabel(cmp.previous.from)} – ${dayLabel(cmp.previous.to)}` : null;
    let text = `${F(trips)} ${plural(trips, 'booking')} ${winPhrase(ctx.win)}`
      + (v.days ? `, ${F(v.perDay)} a day` : '');
    if (ch != null && prev) {
      text += Math.round(ch * 10) === 0 ? `: level with ${prev}` : `: ${F(abs(ch), 1)}% ${ch > 0 ? 'more' : 'fewer'} than ${prev}`;
    }
    /* Under a channel chip every booking is that channel's: "Uber is 100% of
       the work" would be true and say nothing. */
    text += v.lead && v.leadPct && !ctx.platform ? `. ${sourceLabel(v.lead.label)} is ${v.leadPct}% of the work.` : '.';
    const acts = [];
    if (v.uncollected) {
      acts.push(act(`${F(v.uncollected)} of ${C(v.days, 'day')} were never collected — drawn absent, not zero; see which source failed`,
        ctx.href('coverage')));
    }
    if (v.partial) {
      acts.push(act(`${F(v.partial)} of ${C(v.days, 'day')} had a source silent, so their bars read low — see which`, ctx.href('coverage')));
    }
    const cancel = num(k.cancel_pct);
    if (cancel != null && cancel >= 15) {
      acts.push(act(`${F(cancel, 1)}% of bookings did not complete — the acceptance funnel says whose failure each was`, ctx.href('platforms')));
    }
    return { text,
      basis: `Basis: bookings from the booking table — ${scopeWords(ctx)} — in the window; `
        + 'the change is per driver-day, against the same number of days just before.',
      acts, none: 'Nothing to act on: every day was collected with no source silent, and fewer than 15% of bookings failed to complete.' };
  },

  /* #month-target — "Where does the month land at this pace, and who is behind?"
     data: /api/target/month */
  'month-target'(v, ctx) {
    if (!v || v._err) return absent(failed('The month', v?._err));
    const s = v.summary;
    const month = v.month_name || 'This month';
    if (!s) return absent(v.why || `No target is set for ${month}.`);
    if (num(s.month_target) == null) {
      return absent(v._withheld?.REV != null ? 'The month’s target is not shown to your role.' : 'The month’s target could not be read.');
    }
    const days = Array.isArray(v.days) ? v.days : [];
    const past = days.filter((d) => d.state === 'past');
    const tj = v.trajectory || {};
    const basis = 'Basis: the month’s plan against gross fares before commission, both fleets; the pace is '
      + 'the average settled day so far, carried over the days left by weekday.';
    let text;
    if (s.days_left === 0 && past.length) {
      const end = num(s.earned) - num(s.month_target);
      text = `${month} ended ${end >= 0 ? 'on target' : 'short of target'}: ${M(s.earned)} earned, `
        + `${P((100 * s.earned) / s.month_target, 1)} of the ${M(s.month_target)} target; `
        + `${F(s.over)} of ${C(s.days_gone, 'day')} on target.`;
    } else if (tj.avg && num(tj.avg.month_end) != null) {
      text = `At the pace so far, ${month} ends at ${M(tj.avg.month_end)} in gross fares: `
        + `${P(tj.avg.pct, 1)} of the ${M(s.month_target)} target.`;
    } else {
      return absent(`Nothing of ${month} has finished yet, so there is no pace to carry to the month’s end.`, { basis });
    }
    const acts = [];
    const dr = v.drivers && !v.drivers.why ? v.drivers : null;
    const rows = dr?.rows || [];
    const mOff = rows.filter((r) => r.money_on === false).length;
    const tOff = rows.filter((r) => r.trips_on === false).length;
    if (mOff) {
      acts.push(act(`${F(mOff)} of ${C(rows.length, 'active driver')} are behind their money target — the furthest first`,
        ctx.href('month-target'), 'mt-drivers'));
    }
    if (tOff) {
      acts.push(act(`${F(tOff)} of ${C(rows.length, 'active driver')} are behind their trip target over the counted days`,
        ctx.href('month-target'), 'mt-drivers'));
    }
    const r = tj.recent;
    if (s.days_left > 0 && num(s.per_day_left) != null && r && num(r.per_day) != null && r.per_day < s.per_day_left) {
      acts.push(act(`Every day left must bring ${M(s.per_day_left)}; the last ${C(r.days, 'settled day')} averaged `
        + `${M(r.per_day)}`, ctx.href('month-target'), 'mt-path'));
    }
    return { text, basis, acts,
      none: 'Nothing to act on: no active driver is behind, and the recent days carry the month to its target.' };
  },

  /* #drivers — "Who is on the books, who is working, and who may not?"
     data (the directory's own counts, driver.js renderDriverDirectory):
     { total, active, idle, never, expired, notFilled, pendingPairs } */
  drivers(d = {}, ctx) {
    const total = num(d.total);
    if (total == null) return absent('The driver directory did not load.');
    if (!total) return absent('The driver directory holds nobody for this reader.');
    const active = num(d.active) || 0, idle = num(d.idle) || 0, never = num(d.never) || 0;
    const expired = num(d.expired) || 0, notFilled = num(d.notFilled) || 0, pending = num(d.pendingPairs) || 0;
    const text = `${C(total, 'driver')} on the books: ${F(active)} drove ${winPhrase(ctx.win)}, `
      + `${F(idle)} did not and ${F(never)} never have`
      + (expired ? `; ${C(expired, 'holds an expired licence', 'hold an expired licence')}.` : '.');
    const acts = [];
    if (expired) acts.push(act(`${C(expired, 'driver')} cannot legally drive: the licence has expired — check them`, ctx.href('compliance')));
    if (notFilled) {
      acts.push(act(`${C(notFilled, 'driver')} ${notFilled === 1 ? 'has' : 'have'} no real licence date on file — `
        + 'whether they may drive cannot be judged', ctx.href('hr-roster')));
    }
    if (pending) acts.push(act(`${C(pending, 'pair')} of records await review — one person may be counted twice`, ctx.href('same-person')));
    return { text,
      basis: 'Basis: one row per person in the driver directory (reviewed merges only); licence dates from the '
        + 'roster, a placeholder date shared by half the roster excluded.',
      acts, none: 'Nothing to act on: no licence has expired, every driver has a licence date, and no pair of records awaits review.' };
  },

  /* #vehicles — "Which cars are not working?"
     data: { rows: /api/vehicles/directory } — counted with cohorts.js, the
     same predicates the page's verdict and tiles use. */
  vehicles({ rows } = {}, ctx) {
    if (!Array.isArray(rows)) return absent('The vehicle directory did not load.');
    const cars = rows.filter((r) => r.vin);
    if (!cars.length) {
      return absent(rows.length ? `None of the ${C(rows.length, 'plate')} on record carries a VIN, so no car can be counted.`
        : 'No vehicle has any record in this window.');
    }
    const moved = membersOf('vehicles-moved-no-booking', rows).length;
    const still = membersOf('vehicles-still', rows).length;
    const stale = membersOf('vehicles-stale', rows).length;
    const docs = membersOf('vehicles-docs-due', rows).length;
    const earning = cars.length - moved - still;
    const idle = [moved ? `${F(moved)} moved without one` : null, still ? `${F(still)} did not move at all` : null].filter(Boolean);
    const text = idle.length
      ? `${F(earning)} of ${C(cars.length, 'car')} took a booking ${winPhrase(ctx.win)}; ${idle.join(' and ')}.`
      : `All ${C(cars.length, 'car')} took a booking ${winPhrase(ctx.win)}.`;
    const acts = [];
    if (moved) acts.push(act(`${C(moved, 'car')} moved with nothing paying for it — review ${moved === 1 ? 'its' : 'their'} journeys`, ctx.href('cohort', 'vehicles-moved-no-booking')));
    if (still) acts.push(act(`${C(still, 'car')} did not move at all — find them`, ctx.href('cohort', 'vehicles-still')));
    if (stale) acts.push(act(`${C(stale, 'tracker')} ${stale === 1 ? 'has' : 'have'} gone quiet — check ${stale === 1 ? 'it' : 'them'}`, ctx.href('cohort', 'vehicles-stale')));
    if (docs) acts.push(act(`${C(docs, 'car')} ${docs === 1 ? 'has' : 'have'} a document expiring within 30 days`, ctx.href('cohort', 'vehicles-docs-due')));
    return { text,
      basis: 'Basis: every plate with a VIN in the vehicle directory, over the window; a plate with no VIN is set aside, not counted.',
      acts, none: 'Nothing to act on: every car took a booking, every tracker is reporting and no document is due.' };
  },

  /* #unauthorized — "Did cars move with no booking behind them, and what did it cost?"
     data: { sum: /api/unauthorized/summary, vehicles, stuck, dead } — the last
     three are the page's own counts of the ranked vehicles and seat pads. */
  unauthorized({ sum, vehicles = null, stuck = null, dead = null } = {}, ctx) {
    if (!sum) return absent('The unauthorized-trip summary did not load.');
    const t = sum.totals || {};
    const segs = num(t.segments) || 0;
    const w = winPhrase(ctx.win);
    if (!segs) return absent(`No telematics journey was examined ${w}, so nothing can be said about movement without a booking.`);
    const un = num(t.unauthorized) || 0;
    const km = num(t.unauth_km);
    const forgone = num(sum.value?.forgone_aed);
    const human = num(t.needs_a_human) ?? ((num(t.unverifiable) || 0) + (num(t.partial) || 0));
    let text;
    if (un) {
      text = `${F(un)} of ${C(segs, 'journey')} examined ${w} had no booking behind ${un === 1 ? 'it' : 'them'}`
        + (km != null ? `: ${F(km)} km` : '')
        + (forgone != null ? `, ${M(forgone)} revenue forgone.`
          : `; revenue forgone is not valued: ${String(sum.value?.basis || 'there is no rate to value the distance at').replace(/\.$/, '')}.`);
    } else {
      text = `None of the ${C(segs, 'journey')} examined ${w} was found without a booking`
        + (human ? `; ${F(human)} still wait on a person.` : '.');
    }
    const acts = [];
    /* The destination lists exactly what the act counts: verdict
       'unverifiable'. (needs_a_human is the summary's low-confidence count,
       a different set with no list of its own, so it stays in the sentence.) */
    const unver = num(t.unverifiable) || 0;
    if (unver) {
      acts.push(act(`${C(unver, 'journey')} could not be verified: a revenue channel was unreadable at the time — review them`,
        ctx.href('segments', 'verdict', 'unverifiable')));
    }
    if (num(vehicles)) acts.push(act(`${C(vehicles, 'car')} carried an unexplained journey — the worst are ranked`, ctx.href('unauthorized'), 'Vehicles with unexplained trips'));
    if (num(dead) || num(stuck)) {
      acts.push(act(`Seat sensors: ${F(num(stuck) || 0)} stuck, ${F(num(dead) || 0)} dead — every count on this page leans on them`,
        ctx.href('unauthorized'), 'Seat-sensor health'));
    }
    return { text,
      basis: `Basis: every telematics journey in the window (${scopeWords(ctx)}), matched against the bookings `
        + 'of every channel; a journey cut by a telemetry gap is not judged.',
      acts, none: 'Nothing to act on: every journey could be checked against the channels, and every seat sensor reads.' };
  },

  /* #payouts — "Did the money that arrived match what we say was earned?"
     data: { d: /api/finance/payouts, rec: /api/finance/payouts/reconcile } */
  payouts({ d, rec } = {}, ctx) {
    if (!d) return absent('The payout register did not answer.');
    const payouts = d.payouts || [];
    const whole = d.scope === 'record';
    /* Where the page asked for no window (qChan sends none) the server says
       which span it answered over — `window` — and that span, not the window
       chosen for other pages, is what the sentence names. */
    /* …unless it is the server's own sentinel range (2000-01-01 → 2100-01-01),
       which is what an EMPTY register answers over (api/payout_routes.js
       payoutRange: "an empty register has no floor") — printed, it read "No
       transfer reached the bank between 1 Jan 2000 and 1 Jan 2100" on the
       preview. Then the truth is the whole record's: nothing collected. */
    const raw = Array.isArray(d.window) && d.window[0] && d.window[1] ? d.window : null;
    const span = raw && String(raw[0]) > '2000-01-01' && String(raw[1]) < '2100-01-01' ? raw : null;
    const record = whole || (raw && !span);
    const where = record ? 'on record' : span ? `between ${dayLabel(span[0])} and ${dayLabel(span[1])}` : 'in this window';
    const total = payouts.reduce((a, r) => a + (num(r.amount) || 0), 0);
    const ok = rec && !rec.__error;
    const comparable = ok ? (rec.rows || []).filter((r) => num(r.delta) != null) : [];
    const latest = [...comparable].sort((a, b) => (a.paid_on < b.paid_on ? 1 : -1))[0] || null;
    let text;
    if (!payouts.length) {
      text = record
        ? (ctx.platform || ctx.fleet ? `No transfer is on record for ${scopeWords(ctx)}.` : 'No transfer has been collected from any platform yet.')
        : `No transfer reached the bank ${where}.`;
      /* (and the register being empty is said as the page says it: a fact
         about the window, not about the platforms) */
    } else {
      text = `${M(total)} has reached the bank in ${C(payouts.length, 'transfer')} ${where}`
        + (!ok ? '; the comparison with our own figures did not load, so no wire is checked.'
          : latest ? `; the latest checked wire, ${dateStr(latest.paid_on)}, was ${M(abs(latest.delta))} `
            + `${latest.delta >= 0 ? 'above' : 'under'} our figure${num(latest.delta_pct) != null ? ` (${P(abs(latest.delta_pct), 2)})` : ''}.`
            : '; no transfer can be checked against our own figure yet.');
    }
    const acts = [];
    if (ok) {
      const worst = [...comparable].filter((r) => num(r.delta_pct) != null && abs(r.delta_pct) >= 5)
        .sort((a, b) => abs(b.delta_pct) - abs(a.delta_pct))[0];
      if (worst) {
        acts.push(act(`${dateStr(worst.paid_on)}: the wire is ${P(abs(worst.delta_pct), 1)} ${worst.delta >= 0 ? 'above' : 'below'} `
          + 'our figure — check that transfer', ctx.href('payouts'), 'payout-diff'));
      }
      const t = rec.totals || {};
      const unchecked = (num(t.rows) || 0) - (num(t.comparable_rows) || 0);
      if (unchecked > 0) {
        acts.push(act(`${C(unchecked, 'transfer')} cannot be checked: no stated period, or no driver-day figure of ours for it`,
          ctx.href('payouts'), 'Every transfer, by the date it arrived'));
      }
    }
    const silent = (d.coverage || []).filter((c) => !c.publishes_payouts);
    if (silent.length) {
      acts.push(act(`${silent.map((c) => sourceLabel(c.platform)).join(', ')} publish${silent.length === 1 ? 'es' : ''} no transfer — `
        + 'its money is checked nowhere on this page', ctx.href('payouts'), 'What each platform publishes'));
    }
    return { text,
      basis: `Basis: the transfers each platform’s own books record ${record ? 'over the whole record' : span ? 'over that span' : 'in the window'} `
        + `(${scopeWords(ctx)}), each set against our driver-day figure for the week the wire names.`,
      acts, none: 'Nothing to act on: every transfer is checked, none is 5% or more off our figure, and every platform publishes its transfers.' };
  },

  /* #low-performers — "Who is below target, by how much, and why?"
     data: { v: the list endpoint's answer (lowperf.js listUrl), hotelWord: the
     page's own words for its hotel setting (lowperf.js HOTEL_WORD) } */
  'low-performers'({ v, hotelWord = null } = {}, ctx) {
    if (!v || v._err) return absent(failed('The list', v?._err));
    if (v.why) return absent(v.why);
    const rows = v.rows || [];
    const t = v.totals || {};
    const scoped = Number(v._withheld?.FLEET) > 0;
    const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const asked = scoped ? sum('gross_target') : num(t.below_target);
    const earned = scoped ? sum('gross') : num(t.below_gross);
    const days = C(v.counted_days, 'day');
    const n = rows.length;
    const span = v.from === v.to ? dayLabel(v.from) : `${dayLabel(v.from)} – ${dayLabel(v.to)}`;
    const basis = `Basis: each active driver’s gross against their own daily target, ${span}, `
      + `${v.fleet ? sourceLabel(v.fleet) : 'both fleets'}${hotelWord ? `; ${hotelWord.toLowerCase()}` : ''}.`;
    if (!n) return { text: `Nobody is below target over the ${days} counted.`, basis, acts: [], none: 'Nothing to act on: nobody is below target.' };
    const text = `${scoped || num(t.population) == null ? C(n, 'driver') : `${F(n)} of ${C(t.population, 'driver')}`} `
      + `${n === 1 ? 'is' : 'are'} below target over the ${days} counted`
      + (asked ? `, earning ${P((100 * earned) / asked, 1)} of what they were asked.` : '.');
    const acts = [];
    const lt50 = rows.filter((r) => r.band === 'lt50').length;
    const slipping = rows.filter((r) => r.trend?.verdict === 'slipping').length;
    const noCause = num(t.no_cause) || 0;
    if (lt50) acts.push(act(`${C(lt50, 'driver')} ${lt50 === 1 ? 'is' : 'are'} under half of their target — start with them`, ctx.href('low-performers'), 'lp-list'));
    if (slipping) acts.push(act(`${C(slipping, 'driver')} slipped last week against the week before`, ctx.href('low-performers'), 'lp-weeks'));
    if (noCause) acts.push(act(`${C(noCause, 'driver')} below target ${noCause === 1 ? 'carries' : 'carry'} no measured cause — ask them why`, ctx.href('low-performers'), 'lp-why'));
    return { text, basis, acts, none: 'Nothing to act on: nobody is under half, nobody slipped, and every gap has a measured cause.' };
  },

  /* #compare — "Is today running ahead of or behind yesterday?"
     data: { p: /api/compare, a, b } — the two Dubai days compared */
  compare({ p, a, b } = {}, ctx) {
    if (!p || !p.totals) return absent('The comparison did not load.');
    const A = p.totals.a || {}, B = p.totals.b || {};
    const na = num(A.bookings), nb = num(B.bookings);
    if (na == null || nb == null) return absent('The booking counts for the two days could not be read.');
    const partial = num(p.cut_minutes) != null && p.cut_minutes < 1440;
    const d0 = na - nb;
    const lead = partial ? `To ${p.cut_label} Dubai, ${dayStr(a)} has ${C(na, 'booking')} against ${F(nb)} on ${dayStr(b)}`
      : `${dayStr(a)} took ${C(na, 'booking')} against ${F(nb)} on ${dayStr(b)}`;
    const text = lead + (d0 === 0 ? ': the same number.'
      : nb ? `: ${F(abs(d0))} ${d0 > 0 ? 'more' : 'fewer'}, ${d0 > 0 ? '+' : '−'}${F(abs((100 * d0) / nb), 1)}%.`
        : `: ${F(abs(d0))} more, and a change against none is not a percentage.`);
    const acts = [];
    const stopped = (p.stopped || []).length;
    if (stopped) {
      acts.push(act(`${C(stopped, 'person', 'people')} drove on ${dayStr(b)} and ${stopped === 1 ? 'has' : 'have'} not on ${dayStr(a)}`
        + `${partial ? ' so far' : ''} — worth a call`, ctx.href('compare', a, b), 'cmp-roster'));
    }
    const now = ctx.now ? ctx.now.getTime() : Date.now();
    const stale = (p.collectors || []).filter((r) => !r.last_ok || (now - new Date(r.last_ok).getTime()) / 3600e3 > 24).length;
    if (stale) {
      acts.push(act(`${C(stale, 'source')} last succeeded over a day ago — a thin day may be a collection gap`,
        ctx.href('compare', a, b), 'cmp-fresh'));
    }
    return { text,
      basis: partial ? `Basis: both days cut at the same Dubai minute, ${p.cut_label}; bookings on the channels and fleets chosen above.`
        : 'Basis: both days in full; bookings on the channels and fleets chosen above.',
      acts, none: 'Nothing to act on: nobody who drove the day before is missing, and every source collected in the last day.' };
  },

  /* #supply — "When are drivers online with nobody in the car?"
     data: { bal: /api/supply/balance, areas: /api/supply/areas } */
  supply({ bal, areas } = {}, ctx) {
    if (!bal) return absent('The supply balance did not load.');
    if (!bal.covered) {
      const why = bal.uncovered?.reason;
      return absent(why === 'no-feed' ? 'This selection has no availability feed, so there are no online hours to measure idle time against.'
        : why === 'not-yet' ? 'This window is in the future, so nothing has been collected for it yet.'
          : why === 'no-span' ? 'Availability was recorded here but no shift closes, so there are no online hours to divide by.'
            : 'Driver availability was not collected inside this window: Uber serves the last 31 days and nothing older.');
    }
    const t = bal.totals || {};
    const online = num(t.online_h), idle = num(t.idle_h), rate = num(t.jobs_per_online_h), ip = num(t.idle_pct);
    if (online == null || idle == null || ip == null) {
      return absent('The availability feed gave no idle split for this window, so no idle share can be stated.');
    }
    const narrower = bal.measured && bal.measured.narrower_than_window;
    const text = `${cap1(winPhrase(ctx.win))}, ${F(idle)} of ${F(online)} online driver-hours carried nobody (${F(ip)}%)`
      + (rate != null ? `; an online hour sold ${F(rate, 2)} jobs` : '')
      + (narrower ? `, over the ${C(bal.measured.days, 'day')} availability covers.` : '.');
    const acts = [];
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const real = (bal.cells || []).filter((c) => num(c.online_h) >= 3 && num(c.jobs_per_online_h) != null);
    const worst = [...real].sort((x, y) => x.jobs_per_online_h - y.jobs_per_online_h)[0];
    const short = worst && rate ? Math.round((rate - worst.jobs_per_online_h) * worst.online_h * (num(worst.occurrences) || 1)) : null;
    if (worst && short > 0) {
      acts.push(act(`${DOW[worst.dow]} ${String(worst.h).padStart(2, '0')}:00 sells ${F(worst.jobs_per_online_h, 2)} jobs an online hour `
        + `against ${F(rate, 2)} — at the average, about ${F(short)} more ${plural(short, 'job')} this window`, ctx.href('supply'), 'Which hours sell the drivers you are paying for'));
    }
    const A = areas?.areas || [];
    if (A.length) acts.push(act(`Waiting between jobs, area by area: ${C(A.length, 'area')} measured — see where drivers wait longest`, ctx.href('supply'), 'Where the waiting happens'));
    return { text,
      basis: `Basis: drivers’ online and on-job hours from the availability feed, against the jobs they completed, `
        + `in the window (${scopeWords(ctx)}).`,
      acts, none: 'Nothing to act on: no hour with real supply behind it sells below the average.' };
  },

  /* #live — "Where is every car, and which ones have gone quiet?"
     data: { rows: /api/live, fixed: the page's count of rows with a usable fix }
     — or { err } when the call failed, worded as the page words it. */
  live({ rows, fixed = null, err = null } = {}, ctx) {
    if (err || !Array.isArray(rows)) return absent(failed('The live feed', err));
    if (!rows.length) return absent('No feed reports a position for any car right now.');
    const fresh = rows.filter((r) => !r.stale).length;
    const stale = rows.length - fresh;
    const silent = rows.filter((r) => num(r.fix_age_min) != null && r.fix_age_min >= 1440).length;
    /* Moving NOW: a speed read off a fix under 30 minutes old. The page's
       Moving tile counts every row's last speed, so a car silent for a week
       that was doing 40 when it went quiet is "moving" there (found on the
       preview, 2026-11-12: "0 of 5 reported … 5 moving"; AUDIT ANS). A
       sentence that says "right now" may not inherit that. */
    const moving = rows.filter((r) => !r.stale && num(r.speed) > 3).length;
    const noFix = num(fixed) == null ? null : rows.length - fixed;
    const quiet = !silent ? '' : silent === stale ? (stale === 1 ? ' and silent over a day' : ', all silent over a day')
      : `, ${F(silent)} of them silent over a day`;
    const text = `${F(fresh)} of ${C(rows.length, 'car')} reported within 30 minutes`
      + (fresh ? `, ${F(moving)} of them moving` : '')
      + `; ${stale ? `${F(stale)} ${stale === 1 ? 'is' : 'are'} stale${quiet}` : 'none is stale'}.`;
    const acts = [];
    if (silent) acts.push(act(`${C(silent, 'car')} silent over a day — the tracker, not the car, is the first suspect`, ctx.href('live'), 'live-fresh'));
    if (stale) acts.push(act(`${C(stale, 'car')} with a stale fix — sort the table by fix age to bring them together`, ctx.href('live'), 'Live vehicles'));
    if (noFix) acts.push(act(`${C(noFix, 'car')} report no usable fix — counted, never placed on a map`, ctx.href('live'), 'Live vehicles'));
    return { text,
      basis: 'Basis: the latest position from every feed that reports one; stale means no fix in 30 minutes, '
        + 'moving means above 3 km/h at a fix that is not stale.',
      acts, none: 'Nothing to act on: every car reported in the last 30 minutes with a usable fix.' };
  },

  /* #sources — "Which collector has stopped?"
     data (the page's own reading of /api/status, app.js V.sources):
     { rows, bad, partial, quietOk, blank, oldest, ageH, debt } — arrays where
     the page holds arrays, debt from collectionDebt(). */
  sources({ rows, bad = [], partial = [], quietOk = [], blank = [], oldest = null, ageH = null, debt = null } = {}, ctx) {
    if (!Array.isArray(rows)) return absent('The collectors’ status did not load.');
    if (!rows.length) return absent('No collector run is on record.');
    const parts = [];
    if (bad.length) parts.push(`${C(bad.length, 'collector')} failed on ${bad.length === 1 ? 'its' : 'their'} last run`);
    if (partial.length) parts.push(`${C(partial.length, 'run')} left windows unfetched`);
    if (quietOk.length) parts.push(`${F(quietOk.length)} reported success and wrote nothing`);
    const stalest = num(ageH) != null && oldest ? `the stalest scheduled source, ${sourceLabel(oldest.source)}, last finished `
      + `${ageH < 1 ? 'within the hour' : `${F(ageH)} h ago`}` : null;
    const owed = debt && num(debt.days) ? `${F(debt.days)} ${plural(debt.days, 'day')} still owed from ${C(debt.entries, 'refused window')}` : null;
    const text = parts.length
      ? `${cap1(parts.join(', '))}${owed ? `; ${owed}` : ''}${stalest ? `; ${stalest}` : ''}.`
      : `All ${C(rows.length, 'collector run')} last ran clean${stalest ? `; ${stalest}` : ''}.`;
    const acts = [];
    if (bad.length) acts.push(act(`${C(bad.length, 'collector')} failed on the last run — each row says why`, ctx.href('sources'), 'Collector health'));
    if (blank.length) acts.push(act(`${C(blank.length, 'run')} refused every window and wrote nothing — a dead source, not a partial one`, ctx.href('sources'), 'src-why'));
    if (quietOk.length) acts.push(act(`${C(quietOk.length, 'run')} reported success and wrote nothing — check ${quietOk.length === 1 ? 'it' : 'them'}`, ctx.href('sources'), 'Collector health'));
    if (owed) acts.push(act(`${cap1(owed)} — see which days each source covered`, ctx.href('coverage')));
    if (num(ageH) != null && ageH >= 24 && oldest) {
      acts.push(act(`${sourceLabel(oldest.source)} has not finished a scheduled run in ${F(ageH)} h — a feed that has stopped`,
        ctx.href('sources'), 'src-age'));
    }
    return { text,
      basis: 'Basis: the last run of every collector, per source, fleet and mode, as each one recorded it.',
      acts, none: 'Nothing to act on: every collector’s last run wrote rows, no window is owed, and every scheduled feed ran in the last day.' };
  },

  /* #providers — "Which provider refuses us, and what do we throw away?"
     data (the page's own reading of /api/probe/results, providers.js):
     { probed, live, refused, unmapped, worst, unconfigured } */
  providers({ probed = [], live = [], refused = [], unmapped = 0, worst = null, unconfigured = [] } = {}, ctx) {
    if (!probed.length) {
      return absent('No provider has been probed yet: the probe runs from the collector, where the credentials live, once a day or from Settings.');
    }
    const lost = num(unmapped) || 0;
    const text = `${F(live.length)} of ${C(probed.length, 'surface')} answered on the last probe`
      + (refused.length ? `; ${F(refused.length)} refused` : '')
      + (lost ? `, and ${C(lost, 'field')} that providers send ${lost === 1 ? 'has' : 'have'} no column on our side.` : '.');
    const acts = [];
    if (refused.length) acts.push(act(`${C(refused.length, 'surface')} refused on the last probe — read each status code`, ctx.href('providers'), 'Feeds that did not answer'));
    if (lost && worst?.unmapped_n) {
      acts.push(act(`${C(lost, 'field')} sent with no column — ${sourceLabel(worst.provider)}’s ${worst.surface} alone has ${F(worst.unmapped_n)}`,
        ctx.href('providers'), 'prov-unkept'));
    }
    if (unconfigured.length) {
      acts.push(act(`${unconfigured.map((x) => sourceLabel(x.provider)).join(', ')} ${unconfigured.length === 1 ? 'has' : 'have'} no credentials at all`,
        ctx.href('settings')));
    }
    return { text,
      basis: 'Basis: the collector’s last probe of every provider surface — a 2xx with something in it counts as answered.',
      acts, none: 'Nothing to act on: every surface answered and every field is kept.' };
  },

  /* #analyst — "What did the model claim, and what survived the check?"
     data: /api/analyst/findings (the counts are per verdict, every tab) */
  analyst(d, ctx) {
    if (!d) return absent('The analyst’s findings did not load.');
    const lp = d.last_pass || null;
    const total = ['confirmed', 'refuted', 'immaterial', 'unsupported'].reduce((a, k) => a + (num(d[k]) || 0), 0);
    const fail = lp && lp.outcome === 'failed'
      ? `The analyst’s last pass could not reach the model (${dtStr(lp.finished_at)} Dubai): ${String(lp.error || 'no reason was recorded').replace(/\.$/, '')}` : null;
    if (!total) {
      if (fail) return absent(`${ended(fail)} Nothing has been judged since.`, { acts: [act('See what the collector can reach', ctx.href('sources'))] });
      if (d.configured === false || lp?.outcome === 'no_model') {
        return absent('No model is configured for the analyst, so no pass runs and nothing is judged.', { acts: [act('Set the model credential', ctx.href('settings'))] });
      }
      return absent('No analyst pass has run yet, so no claim has been made or checked.');
    }
    const text = `${C(d.confirmed, 'judgement')} survived the check over ${C(d.runs, 'pass', 'passes')}; `
      + `${F(num(d.refuted) || 0)} ${num(d.refuted) === 1 ? 'was' : 'were'} contradicted by the data and `
      + `${F(num(d.immaterial) || 0)} ${num(d.immaterial) === 1 ? 'was' : 'were'} true but too small to act on.`;
    const acts = [];
    if (fail) acts.push(act(`${fail} — nothing new is judged until it is fixed`, ctx.href('sources')));
    if (num(d.confirmed)) acts.push(act(`${C(d.confirmed, 'confirmed judgement')} to review — nothing records whether any was acted on`, ctx.href('analyst')));
    return { text,
      basis: `Basis: every claim the model made${d.model ? ` (${d.model})` : ''}, each checked against the database before it is shown.`,
      acts, none: 'Nothing to act on: no claim survived the check.' };
  },

  /* ── Beyond the main pages ─────────────────────────────────────────────── */

  /* #roster — "Who on the books is not earning, and why?"
     data: /api/roster — totals, and people (for who holds a car while
     stopped); the acts open the cohort lists the page's tiles open. */
  roster(d, ctx) {
    if (!d || !d.totals) return absent('The roster did not load.');
    const t = d.totals;
    const people = num(t.people);
    if (!people) return absent('Nobody is on any platform’s roster for this selection.');
    const working = num(t.working) || 0, idle = num(t.idle_this_window) || 0, never = num(t.never_started) || 0;
    const blocked = num(t.blocked) || 0;
    const text = `${C(people, 'person', 'people')} on the books: ${F(working)} drove ${winPhrase(ctx.win)}, `
      + `${F(idle)} could earn and did not, ${F(never)} never have`
      + (blocked ? `; ${F(blocked)} cannot work on any platform they hold.` : '.');
    const holding = membersOf('roster-blocked-holding', d).length;
    const acts = [];
    if (holding) acts.push(act(`${C(holding, 'person', 'people')} stopped everywhere still ${holding === 1 ? 'holds' : 'hold'} a car — take it back`, ctx.href('cohort', 'roster-blocked-holding')));
    if (blocked) acts.push(act(`${C(blocked, 'person', 'people')} refused by every platform they hold — see which refused`, ctx.href('cohort', 'roster-blocked')));
    if (idle) acts.push(act(`${C(idle, 'person', 'people')} could earn and did not — a licence and a slot standing still`, ctx.href('cohort', 'roster-idle')));
    if (never) acts.push(act(`${C(never, 'recruit')} never drove — a pipeline that stalled`, ctx.href('cohort', 'roster-never-started')));
    return { text,
      basis: `Basis: every person on each platform’s roster (${scopeWords(ctx)}), with the standing each platform reports, over the window.`,
      acts, none: 'Nothing to act on: everyone on the books drove, and nobody is stopped.' };
  },

  /* #retention — "Did the count fall because people left or because nobody joined?"
     data: /api/retention */
  retention(d, ctx) {
    if (!d) return absent('The retention record did not load.');
    if (!d.ok) return absent(d.reason || 'Not enough history to follow a cohort.');
    const f = (d.flow || [])[(d.flow || []).length - 1];
    if (!f || num(f.active) == null) return absent('No complete month is on record yet.');
    const month = d.last_complete_month ? periodLabel(d.last_complete_month) : 'the last complete month';
    const joined = (num(f.joined) || 0) + (num(f.returning) || 0);
    const left = num(f.left) || 0;
    const net = num(f.net);
    const text = `In ${month}, ${F(joined)} ${plural(joined, 'driver')} arrived and ${F(left)} stopped: ${F(f.active)} earning`
      + (net == null ? '.' : net === 0 ? ', level with the month before.' : `, ${net > 0 ? '+' : '−'}${F(abs(net))} on the month before.`);
    const stopped = (d.stopped_last_month || []).length;
    const started = (d.started_last_month || []).length;
    const acts = [];
    if (stopped) acts.push(act(`${C(stopped, 'driver')} worked the month before and stopped — ask why`, ctx.href('cohort', 'retention-stopped')));
    if (started) acts.push(act(`${C(started, 'driver')} took a first booking — keep them`, ctx.href('cohort', 'retention-started')));
    return { text,
      basis: 'Basis: the month each driver first and last took a booking on any channel; the month in progress is left out.',
      acts, none: 'Nothing to act on: nobody stopped and nobody started in the last complete month.' };
  },

  /* #revenue — "Which channels report money, and which do not?"
     data: /api/revenue — the same verdicts.js revenueVerdict the page uses */
  revenue(d, ctx) {
    if (!d || !d.totals) return absent('The money by platform did not load.');
    const t = d.totals;
    const v = revenueVerdict({ platforms: d.platforms || [], totals: t });
    if (num(t.accounted) == null) {
      return absent(`No fare and no payout statement covers ${winPhrase(ctx.win)}, so no money is accounted for${v.bookings ? ` against its ${C(v.bookings, 'booking')}` : ''}.`);
    }
    const text = `${M(t.accounted)} is accounted for ${winPhrase(ctx.win)}: ${F(num(t.accounted_bookings) || 0)} of `
      + `${C(v.bookings, 'booking')} are on a channel whose money we hold`
      + (num(t.priced_bookings) != null ? `, ${F(t.priced_bookings)} with a fare on the trip itself.` : '.');
    const names = (rows) => rows.map((r) => sourceLabel(r.platform)).join(', ');
    const acts = [];
    if (v.dark.length) {
      acts.push(act(`${names(v.dark)} ${v.dark.length === 1 ? 'reports' : 'report'} ${C(v.darkBookings, 'booking')} and no money anywhere — see what ${v.dark.length === 1 ? 'it sends' : 'they send'}`, ctx.href('providers')));
    }
    if (v.payoutOnly.length) {
      acts.push(act(`${names(v.payoutOnly)}: no fare on the trip, money only in the weekly statement — check it against the bank`, ctx.href('reconcile')));
    }
    return { text,
      basis: `Basis: every fare and payout statement on record for the window (${scopeWords(ctx)}); a booking on a channel that files neither is counted, with no money.`,
      acts, none: 'Nothing to act on: every channel with work reports money, and each carries a fare on the trip.' };
  },

  /* #compliance — "Who and what cannot legally work, and what lapses next?"
     data (the page's own counts, app.js V.compliance): { vExpired, vWeek,
     dExpired, dWeek, byPerson, dNoDate, pConflict } — people when the spine
     placed them (byPerson), licence RECORDS when it did not, and the words
     say which. */
  compliance(c = {}, ctx) {
    const vExpired = num(c.vExpired), dExpired = num(c.dExpired);
    if (vExpired == null && dExpired == null) return absent('The compliance record did not load.');
    const soon = (num(c.vWeek) || 0) + (num(c.dWeek) || 0);
    const drv = c.byPerson ? (n) => `${C(n, 'driver')} ${n === 1 ? 'holds' : 'hold'} an expired licence`
      : (n) => `${C(n, 'licence record')} ${n === 1 ? 'has' : 'have'} expired`;
    const parts = [dExpired ? drv(dExpired) : null,
      vExpired ? `${C(vExpired, 'vehicle document')} ${vExpired === 1 ? 'has' : 'have'} expired` : null].filter(Boolean);
    const text = parts.length
      ? `${cap1(parts.join(' and '))}${soon ? `; ${F(soon)} more ${plural(soon, 'document')} expire within a week.` : '.'}`
      : soon ? `Nothing has lapsed; ${C(soon, 'document')} ${soon === 1 ? 'expires' : 'expire'} within a week.`
        : 'No licence or vehicle document has lapsed, and none expires within a week.';
    const acts = [];
    if (dExpired) acts.push(act(`${C(dExpired, c.byPerson ? 'driver' : 'licence record')} cannot legally work — soonest first`, ctx.href('compliance'), 'Driver licences'));
    if (vExpired) acts.push(act(`${C(vExpired, 'vehicle document')} expired — those cars cannot legally work`, ctx.href('compliance'), 'Vehicle documents'));
    if (num(c.pConflict)) acts.push(act(`${C(c.pConflict, 'driver')} ${c.pConflict === 1 ? 'has' : 'have'} records that disagree about a document — a filing error or a wrong merge`, ctx.href('compliance'), 'Driver licences'));
    if (num(c.dNoDate)) acts.push(act(`${C(c.dNoDate, 'record')} carry no licence date — whether they may drive cannot be answered`, ctx.href('hr-roster')));
    return { text,
      basis: c.byPerson
        ? 'Basis: one row per person, each with every account’s documents; a default date a source writes for an empty field is not an expiry.'
        : 'Basis: licence records, not people — the person spine could not place these accounts; vehicle papers by plate.',
      acts, none: 'Nothing to act on: nothing has lapsed, and every record carries a licence date.' };
  },
};

/* ═══ RUNNING A RULE ════════════════════════════════════════════════════════
   Pure: no DOM, no request. The tests call this; the page calls answer(). */
const BAD = /\b(NaN|undefined|null|Infinity)\b|\[object /;
export function answerFor(page, data, ctx = {}) {
  const rule = RULES[page];
  if (!rule) return null;
  const c = { win: ctx.win ?? windowLabel(), platform: ctx.platform ?? null, fleet: ctx.fleet ?? null,
    href: ctx.href || href, now: ctx.now || new Date() };
  let r;
  try {
    r = rule(data, c);
  } catch (e) {
    if (e instanceof Missing) return { page, absent: 'The answer could not be worded: a figure it needs is missing from this page’s data.' };
    return { page, absent: `The answer could not be worked out from this page’s data: ${e?.message || e}.` };
  }
  if (!r) return null;
  const acts = (r.acts || []).filter((a) => a && a.text && a.href).slice(0, ACTS_MAX);
  const words = [r.text, r.absent, r.basis, r.none, ...acts.map((a) => a.text)].filter(Boolean);
  if (words.some((w) => BAD.test(w))) {
    return { page, absent: 'The answer could not be worded: a figure it needs is missing from this page’s data.' };
  }
  return { page, ...r, acts };
}

/* ═══ THE HOOK ══════════════════════════════════════════════════════════════
   The one call a page makes, where its data is in hand:
       answer(view, 'payouts', { d, rec });
   Under the old skin it returns at once (Classic is byte-frozen); a render the
   reader has left draws nothing (answerline.js mountAnswer). */
export function answer(view, page, data) {
  if (!contract()) return null;
  return mountAnswer(view, answerFor(page, data, { win: windowLabel(), platform: state.platform || null,
    fleet: state.fleet || null, href, now: new Date() }));
}

/* For a reader of the code: the page keys that have a rule. */
export const ANSWERED = Object.freeze(Object.keys(RULES));
