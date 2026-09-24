/* The to-do list.
   ──────────────────────────────────────────────────────────────────────────
   Every other page in this product answers a question. This one tells somebody
   to go and do something, which is a much stronger claim, so each row carries
   three things a question never has to: how big it is, how the size was
   computed, and how certain that is.

   The certainty distinction is the point. "AED 58,721 is owed" is a measured
   fact — the rows exist and carry prices. "Nine idle vehicles could produce
   1,300 bookings" is a CEILING: what they would do if every one were
   redeployed and matched the fleet median, both of which are optimistic. Those
   two numbers must never be added together, and a page that sorts by size puts
   the ceiling on top, which is exactly backwards. */

import { dec, empty, fmt, hbars } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money,
         entity, custody, custodyAsOf, dateStr, countOf, plural, verdict,
         contract, glance, secHead, absenceBand, pageFoot } from './ui.js';
import { q, href, store, currentGen, alive } from './data.js';

const GROUPS = [
  { id: 'Collect', blurb: 'Money the fleet has already earned and has not got yet.' },
  { id: 'Protect', blurb: 'Capacity about to stop being able to work. Avoiding a loss, not chasing a gain.' },
  { id: 'Deploy', blurb: 'Vehicles the fleet already owns and is not earning from.' },
  { id: 'Cover', blurb: 'Hours where work reliably turns up and almost nobody is on.' },
  { id: 'Improve', blurb: 'More out of what is already running.' },
];

const CERT = {
  measured: { tone: 'ok', label: 'measured', means: 'The rows exist and carry the figure.' },
  'partly measured': { tone: 'warn', label: 'partly measured', means: 'Some of the rows carry no fare, so the figure is a floor.' },
  observed: { tone: 'ok', label: 'observed', means: 'Counted from what happened; the size is a count, not a projection.' },
  ceiling: { tone: 'warn', label: 'a ceiling', means: 'What it would yield if everything went right. Not an expectation.' },
};

const HORIZON_TONE = { today: 'critical', 'this week': 'warn', 'next rota': 'warn', 'this month': null };

/* Two orders of one page until the operator flips the default skin: the old
   skin's (playbookClassic) and the page contract (playbookContract, plan §4
   #playbook). Both read one /api/playbook answer through the same helpers —
   the tiles, the window caption, the rate control, the new-driver caveat,
   the action cards — so they cannot disagree about a figure. */
export async function renderPlaybook(root) {
  return contract() ? playbookContract(root) : playbookClassic(root);
}

async function playbookClassic(root) {
  root.innerHTML = '';
  loading(root);
  /* The operator's own revenue-per-booking assumption, remembered locally.
     Deliberately empty by default: this fleet's only measured rate comes from
     the corporate hotel channel, and applying it to UberX would invent about
     half a business. */
  const saved = store.get('aedPerTrip', '');
  const d = await q('/api/playbook', saved ? { aed_per_trip: saved } : {});
  root.innerHTML = '';

  if (!d.actions.length) {
    return empty(root, 'Nothing to action. Either the fleet is in good order, or the collectors have not '
      + 'completed a cycle — check Collection gaps before reading it as the first.');
  }

  const t = d.totals || {};
  const fleet = d.fleet || {};

  /* Fields read off /api/playbook on production: totals carries aed_measured,
     aed_modelled, bookings_ceiling_gain, bookings_at_risk, ceiling_unit; each
     action carries a horizon. A to-do list's headline is what the list is
     WORTH, and only the part of it with arithmetic behind it can be totalled —
     the rest is real and unpriced, and saying so is the difference between a
     number and a claim. */
  {
    const measured = +t.aed_measured || 0;
    const soon = d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length;
    const modelled = t.aed_modelled == null ? null : +t.aed_modelled;
    verdict(root, {
      claim: measured
        ? `${countOf(d.actions.length, 'thing')} to do, worth ${money(measured)} a month`
        : `${countOf(d.actions.length, 'thing')} to do`,
      figure: measured ? money(measured) : fmt(d.actions.length),
      unit: measured ? `over ${d.window_days} days` : 'actions',
      tone: soon ? 'warn' : null,
      meta: soon ? `${fmt(soon)} this week or sooner` : null,
      sub: (measured
        ? 'That figure is only the items with arithmetic behind them. '
        : 'None of these carry a size yet. ')
        + (modelled ? `A further ${money(modelled)} is modelled rather than measured. ` : '')
        + (t.bookings_at_risk
          ? `${fmt(t.bookings_at_risk)} ${t.ceiling_unit || 'bookings'} are at risk if nothing changes.`
          : ''),
    });
  }
  // Which window produced this list (windowCap, below).
  {
    const wc = windowCap(d);
    if (wc) root.append(wc);
  }
  root.append(kpiRow(playbookTiles(d)));

  root.append(rateBar(root, saved));
  root.append(el('p', 'cap', esc(d.assumption.note)));

  /* Ordered by horizon then certainty, NOT by size. A ceiling that dwarfs a
     measured amount is not thereby more valuable — it is less certain, and a
     list sorted by size would put the least reliable item at the top. */
  for (const g of GROUPS) {
    const rows = d.actions.filter((a) => a.group === g.id);
    if (!rows.length) continue;
    const { panel: p, body } = panel(g.id, g.blurb);
    root.append(p);
    rows.forEach((a) => body.append(actionCard(a, d)));
  }

  if (fleet.new_driver_first_month != null && fleet.median_bookings
      && fleet.new_driver_first_month < fleet.median_bookings * 0.6) {
    root.append(el('div', 'note err', newDriverCaveat(fleet)));
  }

  root.append(note(SORT_NOTE));
}

/* Shared by both orders of the page. */
const SORT_NOTE = 'Sorted by when it needs doing, then by how certain the size is — never by the size '
  + 'itself. A ceiling that dwarfs a measured amount is not more valuable than it; it is less certain, '
  + 'and sorting by size would put the least reliable row at the top of the list.';
/* Which window produced this list. `d.window` is the response's first key and
   the page printed it nowhere — so "13 vehicles took no booking at all this
   window" is a different list at 7, 30 and 365 days, with nothing on screen
   to say which one you are reading. */
function windowCap(d) {
  if (!d.window) return null;
  const w = Array.isArray(d.window) ? d.window : [d.window.from, d.window.to];
  if (!(w[0] && w[1])) return null;
  return el('p', 'cap',
    `Everything on this page is over ${dateStr(`${String(w[0]).slice(0, 10)}T12:00:00`)} → `
    + `${dateStr(`${String(w[1]).slice(0, 10)}T12:00:00`)}`
    + (d.window_days ? ` (${countOf(d.window_days, 'Dubai day')})` : '')
    + '. Widening the range changes which items appear AND how big each one is sized.');
}
/* The rate control. Money and ceilings stay apart whatever it is set to;
   this only decides whether ceilings get a second, clearly-labelled column. */
function rateBar(root, saved) {
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<label class="cap" for="pbRate">Revenue per booking, for modelling</label>
    <input id="pbRate" type="number" min="0" step="1" placeholder="not set"
           value="${esc(saved)}" style="width:8rem">
    <span class="cap">AED — leave empty and nothing is converted to money</span>`;
  bar.querySelector('#pbRate').onchange = (e) => {
    store.set('aedPerTrip', e.target.value.trim());
    renderPlaybook(root);
  };
  return bar;
}
/* `measuredShare`: the contract's copy says the share it measured. The old
   text's "expect roughly a third of the ceiling" was true when it was
   written (31 against 92 on the mock) and is a fixed claim beside a measured
   one — on production 2026-09-24 it sat after "about 5% of it". */
const newDriverCaveat = (fleet, { measuredShare = false } = {}) => `Every ceiling on this page is a count times the fleet's median earning vehicle `
  + `(${fmt(fleet.median_bookings)} bookings). That benchmark assumes an experienced driver takes each `
  + `car. This fleet's last ${fmt(fleet.new_drivers_measured)} genuinely new drivers produced a median of `
  + `${fmt(fleet.new_driver_first_month)} bookings in their first whole month — about `
  + `${Math.round((fleet.new_driver_first_month / fleet.median_bookings) * 100)}% of it. Where an action `
  + `needs NEW people rather than existing ones, expect ${measuredShare
    ? `about ${Math.round((fleet.new_driver_first_month / fleet.median_bookings) * 100)}%`
    : 'roughly a third'} of the ceiling. That is why `
  + 'reassigning cars from drivers who cannot use them sits above putting idle cars back on the road, '
  + 'despite being the smaller number.';

/* The tiles, as data: the old skin draws them with kpiRow, the contract
   with glance(), from this one list, so the two cannot disagree about a
   figure or a sub-line. */
function playbookTiles(d) {
  const t = d.totals || {};
  const fleet = d.fleet || {};
  return [
    { label: 'Things to do', value: fmt(d.actions.length),
      sub: `${d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length} this week or sooner` },
    { label: 'Money already earned', value: money(t.aed_measured),
      sub: 'measured — these rows carry a price', tone: t.aed_measured ? 'warn' : null },
    /* Named for the unit the server actually computed. The ceilings are per
       WINDOW — the same 31 blocked vehicles are sized 1,163 at seven days and
       51,336 at a year — so a tile reading "bookings/month" is only true at
       one of the five ranges the page offers. It says what it is until the
       server normalises it. */
    { label: 'Idle capacity', value: fmt(t.bookings_ceiling),
      sub: t.ceiling_unit
        ? esc(t.ceiling_unit)
        : `bookings at the fleet median, over ${d.window_days ? countOf(d.window_days, 'day') : 'this window'}`
          + ' — not per month; it scales with the range above',
      tone: t.bookings_ceiling ? 'warn' : null },
    /* The other half of the split, which was computed and never drawn.
       ─────────────────────────────────────────────────────────────────────
       api/playbook_routes.js separates the ceilings into GAIN and PROTECT
       precisely so the two are not added together — its comment says an
       avoided loss on the same cars had been printing as upside. Only the gain
       half reached this page, so a reader saw what the fleet could win and not
       what it stands to lose by doing nothing. A protect action is a document
       about to expire or a driver about to be blocked: the volume behind it is
       not upside, it is the floor falling out. */
    ...(t.bookings_at_risk
      ? [{ label: 'At risk if nothing is done', value: fmt(t.bookings_at_risk),
        sub: `${t.ceiling_unit || 'bookings over this window'} — volume the fleet ALREADY has and `
          + 'would lose, counted apart from the idle capacity beside it so the two are never added',
        tone: 'critical' }]
      : []),
    { label: 'Vehicles earning', value: `${fmt(fleet.earning)} of ${fmt(fleet.vehicles_seen)}`,
      sub: fleet.median_bookings ? `median ${fmt(fleet.median_bookings)} bookings each` : null,
      tone: fleet.earning < fleet.vehicles_seen * 0.6 ? 'critical' : 'warn' },
    /* The benchmark that decides whether the ceiling above is a plan or a
       fantasy. Every ceiling is n × the fleet median, which assumes an
       experienced driver takes each car — and this fleet has just run the
       experiment on what genuinely new capacity delivers. */
    fleet.new_driver_first_month != null
      ? { label: 'What a new driver produces', value: fmt(fleet.new_driver_first_month),
        sub: `bookings in their first whole month, over ${fmt(fleet.new_drivers_measured)} recent joiners`
          + (fleet.median_bookings
            ? ` — ${Math.round((fleet.new_driver_first_month / fleet.median_bookings) * 100)}% of the median`
            : ''),
        tone: fleet.median_bookings && fleet.new_driver_first_month < fleet.median_bookings * 0.6
          ? 'critical' : null }
      : null,
    t.aed_modelled != null
      ? { label: 'Modelled upside', value: money(t.aed_modelled),
        sub: `at ${money(d.assumption.aed_per_trip)}/booking — an assumption`, tone: 'warn' }
      : null,
  ];
}

/* `neutral` is the contract's card: under the colour law green and red mean
   better and worse and nothing else, and CERT painted "measured" green and
   "a ceiling" amber, HORIZON_TONE "today" red — a certainty is not good news
   and a deadline is not bad news. So the pills are ink chips, and the
   certainty carries the FORM its figure has everywhere else: a ceiling is a
   projection (the hatch swatch), a measured or observed size is solid. */
function actionCard(a, d, { neutral = false } = {}) {
  const card = el('div', 'card act');
  const cert = CERT[a.certainty] || { tone: null, label: a.certainty, means: '' };

  const head = el('div', 'act-head');
  const certChip = neutral
    ? `<span class="pill act-cert" data-cert="${esc(a.certainty)}"><i class="sw${a.certainty === 'ceiling' ? ' sw-proj' : ''}" `
      + `style="background:var(--ink)" aria-hidden="true"></i>${esc(cert.label)}</span>`
    : pill(cert.label, cert.tone);
  head.innerHTML = `<div class="act-title">${esc(a.title)}</div>
    <div class="act-tags">
      ${pill(a.horizon, neutral ? null : HORIZON_TONE[a.horizon])}
      ${certChip}
      ${pill(`${a.effort} effort`, null)}
    </div>`;
  card.append(head);

  card.append(el('p', 'act-why', esc(a.why)));

  // The numbers, each labelled with what kind of number it is.
  const figs = [];
  if (a.aed_measured) figs.push([money(a.aed_measured), 'measured, already earned']);
  if (a.ceiling) figs.push([`${fmt(a.ceiling)}`, a.ceiling_unit || 'ceiling']);
  if (a.aed_modelled != null) {
    figs.push([money(a.aed_modelled), `modelled at ${money(d.assumption.aed_per_trip)}/booking`]);
  }
  if (a.size) figs.push([fmt(a.size), a.size_unit]);
  if (figs.length) {
    card.append(el('div', 'act-figs', figs.map(([v, l]) =>
      `<span class="act-fig"><b>${esc(v)}</b><i>${esc(l)}</i></span>`).join('')));
  }

  /* How the size was computed, from which rows. An action nobody can check is
     an opinion with a database behind it, and this is the field that makes the
     difference. */
  const basis = el('details', 'act-basis');
  basis.innerHTML = `<summary>How this was worked out</summary>
    <p>${esc(a.basis)}</p>
    <p class="cap">${esc(cert.means)}</p>`;
  if (a.detail?.length) {
    /* The evidence table is built from whatever keys the action returned, which
       kept it honest — a new field on an action appears here without anyone
       remembering to add it. But esc(String(v)) is only right for scalars: it
       printed a plate as dead text next to a driver as dead text, so the one
       table in the product whose whole job is "check this yourself" was the one
       you could not click out of. And once actions started carrying custody,
       it rendered [object Object].

       So: scalars still fall through to the generic path, and the handful of
       keys that name an entity render as links. Keys that exist only to carry
       an id or a count for another column are folded into it rather than shown
       as their own column of noise. */
    /* `partner_id` is a Mongo id no page navigates by; it was a column of
       twenty-four hex characters sitting where the reader looks for a name. */
    const HIDDEN = new Set(['driver_ext_id', 'driver_n', 'partner_id']);
    const RENDER = {
      plate: (r) => entity('vehicle', r.plate, r.plate),
      plates: (r) => (Array.isArray(r.plates) && r.plates.length
        ? r.plates.map((pl) => entity('vehicle', pl, pl)).join(' ') : '\u2014'),
      driver: (r) => entity('driver', r.driver_ext_id, r.driver),
      driver_name: (r) => entity('driver', r.driver_ext_id, r.driver_name),
      counterparty: (r) => (r.driver_ext_id
        ? entity('driver', r.driver_ext_id, r.counterparty) : esc(String(r.counterparty ?? '\u2014'))),
      held_by: (r) => custodyAsOf(r.held_by),
      driver_refs: (r) => custody(r) + (r.driver_n > (r.driver_refs || []).length
        ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)} more</span>` : ''),
      amount: (r) => money(r.amount),
      pct: (r) => (r.pct == null ? '\u2014' : `${dec(r.pct, 1)}%`),
      avg_return_km: (r) => (r.avg_return_km == null ? '\u2014' : `${dec(r.avg_return_km, 1)} km`),
      expires_at: (r) => dateStr(r.expires_at),
      last_booking: (r) => dateStr(r.last_booking),
      days_left: (r) => (r.days_left == null ? '\u2014'
        : (Number(r.days_left) <= 0 ? pill('today', 'critical')
          : `${fmt(r.days_left)}${Number(r.days_left) <= 7 ? ' ' + pill('soon', 'warn') : ''}`)),
      state: (r) => pill(String(r.state ?? ''), 'warn'),
      settlement_class: (r) => pill(String(r.settlement_class ?? '').replace(/_/g, ' ')),
      platform: (r) => pill(String(r.platform ?? '')),
      /* `unpriced_channel: false` printed the word "false" under a heading that
         read "unpriced channel", which asks the reader to negate a negative to
         learn that the fare IS recorded. Stated the plain way round instead. */
      unpriced_channel: (r) => (r.unpriced_channel ? pill('no', 'warn') : 'yes'),
    };
    /* Every other table in this product uses sentence case; these were raw
       column names with the underscores swapped for spaces. */
    const LABEL = {
      driver_refs: 'Driven by', held_by: 'Held by', plate: 'Plate', plates: 'Plates',
      driver: 'Driver', driver_name: 'Driver', counterparty: 'Counterparty',
      settlement_class: 'Settlement class', trips: 'Bookings', amount: 'Amount owed',
      oldest_days: 'Oldest, days', priced: 'With a fare', unpriced_channel: 'Fares recorded',
      expires_at: 'Expires', days_left: 'Days left', state: 'Why blocked',
      place: 'Drop-off area', drops: 'Drop-offs', avg_return_km: 'Average return',
      platform: 'Platform', lost: 'Lost', judged: 'Requests judged', pct: 'Lost share',
      journeys: 'Journeys', last_booking: 'Last booking',
    };
    /* Counts arrived through String(v): "45970" where the rest of the product
       writes 45,970. */
    const NUM = new Set(['trips', 'priced', 'drops', 'lost', 'judged', 'journeys', 'oldest_days']);
    /* Columns are built from whatever keys the finding's evidence carries, so a
       field the generator emits but never fills becomes a column of dashes —
       "last booking" was empty in all twelve rows of one action. The reason
       cannot be specific here, because the shape is different for every rule;
       what it CAN say is that the evidence itself carries nothing, which is
       the difference between "these vehicles have no last booking" and "this
       page failed to show one". */
    const cols = Object.keys(a.detail[0]).filter((k) => !HIDDEN.has(k)).map((k) => ({
      label: LABEL[k] || k.replace(/_/g, ' '), key: k,
      num: NUM.has(k) || k === 'amount' || k === 'pct' || k === 'days_left',
      absent: 'the evidence behind this finding carries no '
        + `${(LABEL[k] || k.replace(/_/g, ' ')).toLowerCase()} for any of its rows`,
      render: RENDER[k]
        || (NUM.has(k) ? (r) => (r[k] == null ? '\u2014' : fmt(r[k]))
          : (r) => (r[k] == null ? '\u2014' : esc(String(r[k])))),
    }));
    const tbl = tableFrom(a.detail, cols, { compact: true });
    basis.append(tbl);
    if (a.detail_of) {
      /* Not every finding's evidence is a sample of what the finding counts.
         The cancellations rule counts lost BOOKINGS and hands back one row per
         PLATFORM, which the generic caption rendered as "Showing 3 of 1,288" —
         three of a thousand two hundred and eighty-eight what? */
      basis.append(el('p', 'cap',
        `${countOf(a.detail.length, a.detail_of)}, covering all `
        + `${fmt(a.size)} ${a.size_unit || 'rows'}.`));
    } else if (a.size > a.detail.length) {
      basis.append(el('p', 'cap', `Showing ${a.detail.length} of ${fmt(a.size)}.`));
    } else if (a.detail.length > a.size) {
      /* The renewals finding counts documents expiring inside SEVEN days and
         hands back the whole forty-five day query as its evidence, so a
         headline reading "8" sat above a table of twelve. The extra rows are
         worth seeing — they are what comes next — but the table has to say
         that rather than leave the reader to think one of the two is wrong. */
      basis.append(el('p', 'cap',
        `The headline counts ${fmt(a.size)} ${a.size_unit || 'rows'} — the ones this finding is about. `
        + `The table carries ${fmt(a.detail.length - a.size)} more from the same query for context, `
        + 'which the columns distinguish.'));
    }
  }
  card.append(basis);

  const foot = el('div', 'act-foot');
  foot.innerHTML = `<a class="lnk" href="${esc(a.link)}">Open the evidence →</a>`;
  card.append(foot);
  return card;
}

/* ── #playbook under the page contract (plan §4 #playbook) ─────────────────
   A to-do list, so the cards, their evidence tables, the rate control and
   the order (horizon, then certainty, never size) are restyled only (rule 3).
   In SPEC §1's order:

     00  AT A GLANCE — the verdict as the statement, its unit FIXED: the
         measured total is receivables owed plus cash held, a BALANCE, and
         "worth AED X a month … over 23 days" called it a monthly flow. It
         reads "already earned and not yet in hand". Then the tiles, Money
         already earned the hero; no tile wears a tone (a judged level is not
         better-or-worse under the colour law, ruling 1's dots are for
         warnings); Idle capacity adds the same ceiling at a NEW driver's
         rate as a sub-line; Modelled upside is ABSENT with its reason when
         no rate is set, instead of vanishing.
     —   the rate control and its assumption note, unchanged.
     01  Where the fleet's cars are — earned / took no booking / moved but
         never earned, from .fleet; the last is drawn only where the journey
         feed filed something in the window (.fleet.journeys_in_window, added
         for this page) — otherwise a 0 there is not a measurement and is
         drawn as the absence OUTLINE with its reason.
     02  The arithmetic behind the ceilings — the median earning car against
         a new driver's first whole month.
     03… Collect, Protect, Deploy, Cover, Improve — the same cards, neutral
         chips (see actionCard).
     †   the new-driver caveat moves here as "The ceiling is not a forecast",
         its text unchanged and not in red, beside the rate, the certainty
         split and the moved-but-never-earned measurement.

   NOT ADOPTED: a "2,124 bookings" hero (a projection made the headline of a
   to-do list); the 4-up "what each job is worth" (it puts ceilings beside
   money and invites adding them); the document and cash-balance dot plots
   (they redraw evidence tables that carry more columns and links). */
async function playbookContract(root) {
  const gen = currentGen();
  root.innerHTML = '';
  loading(root);
  const saved = store.get('aedPerTrip', '');
  const d = await q('/api/playbook', saved ? { aed_per_trip: saved } : {});
  if (!alive(gen)) return;
  root.innerHTML = '';
  if (!d.actions.length) {
    return empty(root, 'Nothing to action. Either the fleet is in good order, or the collectors have not '
      + 'completed a cycle — check Collection gaps before reading it as the first.');
  }
  const t = d.totals || {};
  const fleet = d.fleet || {};
  const n = d.actions.length;
  const measured = +t.aed_measured || 0;
  const soon = d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length;
  const modelled = t.aed_modelled == null ? null : +t.aed_modelled;
  const w = Array.isArray(d.window) ? d.window : d.window ? [d.window.from, d.window.to] : [];
  const winNote = w[0] && w[1]
    ? `${dateStr(`${String(w[0]).slice(0, 10)}T12:00:00`)} → ${dateStr(`${String(w[1]).slice(0, 10)}T12:00:00`)}`
      + (d.window_days ? ` · ${countOf(d.window_days, 'Dubai day')}` : '')
    : null;

  /* ── 00 ──────────────────────────────────────────────────────────────── */
  const band = el('section', 'cband');
  const vHost = el('div');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', winNote), vHost, tiles);
  const wc = windowCap(d);
  if (wc) band.append(wc);
  root.append(band);
  verdict(vHost, {
    claim: measured
      ? `${countOf(n, 'thing')} to do — ${money(measured)} already earned and not yet in hand`
      : `${countOf(n, 'thing')} to do`,
    figure: measured ? money(measured) : fmt(n),
    unit: measured ? 'already earned, not yet in hand' : 'actions',
    tone: soon ? 'warn' : null,
    meta: soon ? `${fmt(soon)} this week or sooner` : null,
    sub: (measured
      ? 'That figure is a balance — money owed and cash held — and only the items with arithmetic behind them. '
      : 'None of these carry a size yet. ')
      + (modelled ? `A further ${money(modelled)} is modelled rather than measured. ` : '')
      + (t.bookings_at_risk
        ? `${fmt(t.bookings_at_risk)} ${t.ceiling_unit || 'bookings'} are at risk if nothing changes.`
        : ''),
  });
  const base = Object.fromEntries(playbookTiles(d).filter(Boolean).map((x) => [x.label, x]));
  const plain = (x) => (x ? { ...x, tone: null } : null);
  const idle = d.actions.find((a) => a.id === 'redeploy_idle_vehicles');
  const idleTile = plain(base['Idle capacity']);
  if (idleTile && idle?.size && fleet.new_driver_first_month != null) {
    idleTile.sub = `${idleTile.sub} · at a new driver's first-month rate, ${fmt(idle.size * fleet.new_driver_first_month)} `
      + `(${fmt(idle.size)} cars × ${fmt(fleet.new_driver_first_month)}) — a ceiling too`;
  }
  glance(tiles, [
    measured ? { ...plain(base['Money already earned']), hero: true }
      : { ...plain(base['Money already earned']), hero: true, na: 'no item here carries a measured amount', sub: null },
    plain(base['Things to do']),
    idleTile,
    plain(base['At risk if nothing is done']),
    plain(base['Vehicles earning']),
    plain(base['What a new driver produces']),
    base['Modelled upside'] ? plain(base['Modelled upside'])
      : { label: 'Modelled upside', na: 'no revenue-per-booking rate set — nothing is converted to money', sub: null },
  ]);

  /* ── the rate control, unchanged ─────────────────────────────────────── */
  root.append(rateBar(root, saved));
  root.append(el('p', 'cap', esc(d.assumption.note)));

  /* ── 01 · where the fleet's cars are ─────────────────────────────────── */
  const where = panel('Where the fleet\'s cars are', null, 'pb-where');
  root.append(where.panel);
  const jw = fleet.journeys_in_window;
  const movedKnown = Number(fleet.moved_only) > 0 || Number(jw) > 0;
  const rows = movedKnown
    ? [{ label: 'Earned at least one booking', n: fleet.earning },
      { label: 'Moved, but never earned', n: fleet.moved_only },
      { label: 'Took no booking and did not move', n: fleet.still }]
    : [{ label: 'Earned at least one booking', n: fleet.earning },
      { label: 'Took no booking', n: (Number(fleet.still) || 0) + (Number(fleet.moved_only) || 0) }];
  hbars(where.body, rows, { signed: false,
    shareOf: (r) => (fleet.vehicles_seen ? `${(r.n / fleet.vehicles_seen * 100).toFixed(1)}%` : null) });
  if (!movedKnown) {
    const out = el('div', 'hbars pb-unmoved');
    out.innerHTML = `<div class="hb"><div class="k">Of those, moved without a booking</div>
      <div class="track"><div class="fill hb-outline" style="width:24%"></div></div>
      <div class="v"><span class="ak-why">Not measured</span></div></div>`;
    where.body.append(out);
  }
  where.body.append(el('p', 'cap', esc(`${fmt(fleet.earning)} of ${fmt(fleet.vehicles_seen)} vehicles earned in this window. `
    + 'The vehicles are every plate the fleet has ever had in a booking, a tracker fix or a document — a car '
    + 'that did nothing at all is still one of them. '
    + (movedKnown ? `Moved means the trackers filed a journey for it${jw != null ? ` (${fmt(jw)} journeys in the window)` : ''}.`
      : jw === 0 ? 'Whether an idle car MOVED is read from the trackers\' journeys, and none were filed in this '
        + 'window — so moving and standing still cannot be told apart, and the split is drawn as not measured.'
        : 'Whether an idle car moved is read from the trackers\' journeys, and this server does not say whether '
          + 'any were filed in the window — so a split of 0 is not drawn as one.'))));

  /* ── 02 · the arithmetic behind the ceilings ─────────────────────────── */
  const arith = panel('The arithmetic behind the ceilings', null, 'pb-arith');
  root.append(arith.panel);
  const med = fleet.median_bookings, nd = fleet.new_driver_first_month;
  if (med == null || nd == null) {
    empty(arith.body, med == null ? 'No vehicle earned in this window, so there is no median to size a ceiling with.'
      : 'No genuinely new driver has a whole first month in the record, so the ceilings cannot be set against one.');
  } else {
    hbars(arith.body, [
      { label: 'The median earning car', n: med },
      { label: 'A new driver\'s first whole month', n: nd },
    ], { signed: false, valueFmt: (v) => `${fmt(v)} bookings` });
    arith.body.append(el('p', 'cap', esc(`Bookings per 30 days (${fleet.median_unit || 'the median\'s unit'}). Every ceiling below `
      + `is a count × the median car; a new driver produced ${Math.round(nd / med * 100)}% of it in their first whole month, `
      + `over ${countOf(fleet.new_drivers_measured || 0, 'recent joiner')}.`)));
  }

  /* ── 03… · the groups, the same cards ────────────────────────────────── */
  for (const g of GROUPS) {
    const list = d.actions.filter((a) => a.group === g.id);
    if (!list.length) continue;
    const { panel: p, body } = panel(g.id, g.blurb, `pb-${g.id.toLowerCase()}`);
    root.append(p);
    list.forEach((a) => body.append(actionCard(a, d, { neutral: true })));
  }

  /* ── † ───────────────────────────────────────────────────────────────── */
  const absHost = el('div'); root.append(absHost);
  const certain = d.actions.filter((a) => a.certainty === 'measured' || a.certainty === 'observed').length;
  absenceBand(absHost, [
    { label: 'The ceiling is not a forecast', hl: true,
      fig: med && nd != null ? `${Math.round(nd / med * 100)}%` : null, none: 'Not measured',
      why: med && nd != null ? newDriverCaveat(fleet, { measuredShare: true })
        : 'Every ceiling is a count times the median earning car, and no new driver\'s first whole month is in the '
          + 'record to check it against.' },
    { label: 'What a booking is worth', fig: saved ? money(saved) : null, none: 'No rate set',
      why: `${saved ? 'The rate above is yours, not a measurement. ' : ''}${d.assumption.note}` },
    { label: 'Items with a measured size', fig: `${fmt(certain)} of ${fmt(n)}`,
      why: 'The rest are ceilings or partly measured: what they would yield if everything went right, or a floor '
        + 'where some rows carry no fare. They are never added to money.' },
    movedKnown
      ? { label: 'Whether an idle car can work', fig: null, none: 'Not known',
        why: 'A car that took no booking may be in the workshop, held in reserve or waiting for a driver, and nothing '
          + 'in the record says which — so every idle car counts toward the ceiling as though it could work.' }
      : { label: 'Cars that moved but never earned', fig: null, none: 'Not measured',
        why: jw === 0 ? 'The trackers filed no journey in this window, so a car that moved cannot be told from one that stood still.'
          : 'This server does not say whether the trackers filed any journey in this window, so a 0 here is not a count.' },
  ]);
  root.append(note(SORT_NOTE));
  pageFoot({ colophon: [
    winNote || 'The playbook\'s window',
    `${countOf(n, 'thing')} to do · ${fmt(soon)} this week or sooner`,
    measured ? `${money(measured)} earned, not in hand` : null,
  ] }, root);
}
