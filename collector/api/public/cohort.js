/* Who exactly? — the page behind a number.
   ─────────────────────────────────────────────────────────────────────────
   A tile says "33 insured and idle". This page is the 33: named, ranked, and
   with every source that holds anything about them gathered onto one screen.

   The membership is not recomputed here. The page fetches the SAME endpoint
   the tile fetched and applies the SAME predicate — api/public/cohorts.js
   holds both — so the count in the tile and the number of rows below it are
   the same arithmetic, not two arithmetics that happen to agree today.

   What IS new is the second fetch. /api/cohort/{drivers,vehicles} takes the
   ids and returns what every other system says about them: standing from one
   provider, pay from another's statement, hours from a supplier session, the
   car from custody, harsh braking from a telematics box, papers from the
   fleet portal. That join used to be a page load per person. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill,
  dayStr, dtStr, money, fmt, pct, plural, countOf, verdict, foldRows, foldChildren,
  sourceLabel } from './ui.js';
import { q, qAll, api, href, params, unfiltered } from './data.js';
import { empty } from './charts.js';
import { COHORTS, membersOf, idOf, accountsOf } from './cohorts.js';

const hrs = (min, d = 0) => (min == null ? null : fmt(Number(min) / 60, d));
const sumOf = (a, f) => a.reduce((x, r) => x + (Number(f(r)) || 0), 0);

/* One card: everything every source holds about one member. Sections are
   omitted when their source said nothing, and the omission is stated once at
   the bottom rather than as six empty boxes. */
function memberCard(host, kind, row, detail) {
  const card = el('div', 'panel cohort-card');
  const id = idOf(kind, row);
  const name = kind === 'vehicle' ? row.plate : (row.driver_name || row.name || id);
  const head = el('div', 'cohort-head');
  head.innerHTML = `<h3>${entity(kind === 'vehicle' ? 'vehicle' : 'driver', id, name)}</h3>`;
  card.append(head);

  const facts = [];
  const said = [];   // which sources actually answered
  const silent = []; // and which did not

  if (kind === 'vehicle') {
    const d = detail || {};
    const w = d.work || [];
    const bookings = sumOf(w, (r) => r.bookings);
    const journeys = sumOf(w, (r) => r.journeys);
    if (d.spec && (d.spec.make || d.spec.model)) {
      said.push('fleet register');
      head.append(el('p', 'cap', [d.spec.year, d.spec.make, d.spec.model, d.spec.colour]
        .filter(Boolean).join(' ') + (d.spec.vin ? ` · VIN ${d.spec.vin}` : '')));
    }
    if (w.length) {
      said.push('ride platforms');
      facts.push({ label: 'Bookings', value: fmt(bookings),
        sub: `${countOf(w.length, 'channel')} · ${fmt(sumOf(w, (r) => r.km))} km` });
      /* Only where a channel actually priced something. Uber's export carries
         no fare column at all, so summing to zero and printing "AED 0" reads
         as "this car earned nothing" when it means "this channel does not say".
         Uber is nine bookings in ten here, so that tile would be wrong on
         almost every card. */
      const fareSum = sumOf(w, (r) => r.fares);
      if (fareSum) {
        facts.push({ label: 'Fares reported', value: money(fareSum),
          sub: `${countOf(w.filter((r) => r.fares).length, 'channel')} prices its own trips` });
      }
    }
    if (journeys) {
      said.push('telematics journeys');
      facts.push({ label: 'Journeys, no booking', value: fmt(journeys),
        sub: `${fmt(sumOf(w, (r) => r.journey_km))} km the tracker saw`,
        tone: bookings ? null : 'critical' });
    }
    if (d.telematics) {
      said.push('tracker');
      facts.push({ label: 'Last fix', value: d.telematics.fix_age_min == null ? '—'
        : d.telematics.fix_age_min > 1440 ? `${fmt(d.telematics.fix_age_min / 1440, 0)} d ago`
          : `${fmt(d.telematics.fix_age_min)} min ago`,
      sub: `${sourceLabel(d.telematics.source)}${d.telematics.status ? ` · ${d.telematics.status}` : ''}`,
      tone: d.telematics.fix_age_min > 1440 ? 'critical' : d.telematics.fix_age_min > 11 ? 'warn' : 'good' });
    } else silent.push('no tracker has ever reported a position');
    if ((d.custody || []).length) {
      said.push('custody');
      const c = d.custody[0];
      facts.push({ label: 'Held by', value: c.driver_name || '—',
        sub: `${countOf(c.days, 'day')} · last ${dayStr(c.last_day)}`
          + (d.custody.length > 1 ? ` · ${d.custody.length - 1} other` : '') });
    } else silent.push('nobody is recorded as having held it in this window');
    const due = (d.documents || []).filter((x) => x.days_left != null);
    if (due.length) {
      said.push('fleet portal');
      const soon = due[0];
      facts.push({ label: 'Nearest paper', value: `${fmt(soon.days_left)} d`,
        sub: `${soon.doc_type}${soon.status ? ` · ${soon.status}` : ''}`,
        tone: soon.days_left < 0 ? 'critical' : soon.days_left < 30 ? 'warn' : 'good' });
    } else silent.push('no document with an expiry date');
    if ((d.alerts || []).length) {
      said.push('driving events');
      facts.push({ label: 'Harsh events', value: fmt(sumOf(d.alerts, (r) => r.n)),
        sub: `worst: ${d.alerts[0].alert_type}`, tone: 'warn' });
    }
    const unauth = (d.segments || []).find((x) => x.verdict === 'unauthorized');
    if (unauth) {
      said.push('seat sensor');
      facts.push({ label: 'Unauthorized', value: fmt(unauth.n),
        sub: `${fmt(unauth.km)} km carried with no booking open`, tone: 'critical' });
    }
    if ((d.utilisation || []).length) {
      said.push('platform utilisation');
      const u = d.utilisation[0];
      facts.push({ label: 'Platform hours', value: `${fmt(u.hours_online, 0)} h`,
        sub: `${sourceLabel(u.platform)}${u.utilisation != null ? ` · ${pct(u.utilisation * 100)} used` : ''}` });
    }
  } else {
    const d = detail || {};
    const w = d.work || [];
    const bookings = sumOf(w, (r) => r.bookings);
    const payout = sumOf(d.pay || [], (r) => r.payout);
    const fares = sumOf(w, (r) => r.fares);
    if (w.length) {
      said.push('ride platforms');
      facts.push({ label: 'Bookings', value: fmt(bookings),
        sub: `${countOf(sumOf(w, (r) => r.days) ? new Set(w.map((r) => r.platform)).size : 0, 'channel')}`
          + ` · ${fmt(sumOf(w, (r) => r.km))} km` });
    } else silent.push('no channel reports a booking in this window');
    if ((d.pay || []).length || fares) {
      said.push('payout statements');
      facts.push({ label: 'Money', value: money(payout + fares),
        sub: payout && fares ? 'payouts and fares' : payout ? 'bank payouts' : 'fares only',
        tone: payout + fares ? null : 'critical' });
    } else silent.push('no statement pays them anything in this window');
    const a = d.availability;
    if (a && a.online_min) {
      said.push('supplier availability');
      const idlePct = a.online_min ? Math.round((a.idle_min / a.online_min) * 100) : null;
      facts.push({ label: 'Online', value: `${hrs(a.online_min)} h`,
        sub: idlePct == null ? `${countOf(a.days, 'day')}` : `${idlePct}% with nobody in the car`,
        tone: idlePct != null && idlePct >= 85 ? 'warn' : null });
    } else silent.push('nothing measured how long they were online');
    if ((d.standing || []).length) {
      said.push('provider standing');
      const st = d.standing[0];
      facts.push({ label: 'Standing', value: st.state || '—',
        sub: `${sourceLabel(st.platform)}${st.can_earn === false ? ' · cannot earn' : st.can_earn ? ' · can earn' : ''}`,
        tone: st.can_earn === false ? 'critical' : st.can_earn ? 'good' : 'warn' });
    } else silent.push('no provider describes their standing');
    const lic = (d.compliance || []).find((x) => x.licence_expires);
    if (lic) {
      said.push('compliance');
      facts.push({ label: 'Licence', value: lic.licence_days_left == null ? dayStr(lic.licence_expires)
        : `${fmt(lic.licence_days_left)} d`,
      sub: `${sourceLabel(lic.platform)} · ${dayStr(lic.licence_expires)}`,
      tone: lic.licence_days_left < 0 ? 'critical' : lic.licence_days_left < 30 ? 'warn' : 'good' });
    }
    if ((d.cars || []).length) {
      said.push('custody');
      const c = d.cars[0];
      facts.push({ label: 'Car held', value: c.plate,
        sub: `${countOf(c.days, 'day')} · last ${dayStr(c.last_day)}`
          + (d.cars.length > 1 ? ` · ${d.cars.length - 1} other` : '') });
    } else silent.push('they held no car in this window');
    if ((d.alerts || []).length) {
      said.push('driving events');
      facts.push({ label: 'Harsh events', value: fmt(sumOf(d.alerts, (r) => r.n)),
        sub: `worst: ${d.alerts[0].alert_type}`, tone: 'warn' });
    }
    if ((d.performance || []).length) {
      said.push('platform scorecard');
      const p = d.performance[0];
      facts.push({ label: 'Platform hours', value: p.hours_online == null ? '—' : `${fmt(p.hours_online, 0)} h`,
        sub: `${sourceLabel(p.platform)}${p.rating != null ? ` · rated ${fmt(p.rating, 2)}` : ''}` });
    }
    if ((d.not_completed || []).length) {
      const worst = d.not_completed[0];
      facts.push({ label: 'Did not complete', value: fmt(sumOf(d.not_completed, (r) => r.n)),
        /* The channel's own word, not the fold — "not completed" is what the
           number above already said. */
        sub: `most often ${String(worst.status || worst.outcome).replace(/_/g, ' ')}` });
    }
  }

  if (facts.length) card.append(kpiRow(facts));
  else card.append(note('No source holds anything about this one inside the window.'));

  /* Which systems answered, and which had nothing. A card that simply omits a
     section leaves the reader unable to tell "clean" from "not collected". */
  const line = el('p', 'cap');
  line.innerHTML = said.length
    ? `Answered by ${esc(said.join(', '))}.`
      + (silent.length ? ` <span class="dim">Silent: ${esc(silent.join('; '))}.</span>` : '')
    : `<span class="dim">Every source was silent about this one in this window.</span>`;
  card.append(line);
  host.append(card);
}

export async function renderCohort(root, key) {
  const c = COHORTS[key];
  if (!c) {
    empty(root, 'That drill-down does not exist');
    return null;
  }
  const vHost = el('div'); root.append(vHost); loading(vHost);
  const kpiHost = el('div'); root.append(kpiHost);
  const tblP = panel('Every one of them', 'Ranked by what is at stake, and each openable in full');
  root.append(tblP.panel); loading(tblP.body);
  const cardsP = panel('What every source says',
    'One card per member, with every system that holds anything about them on the same screen');
  root.append(cardsP.panel); loading(cardsP.body);

  /* The tile's own fetch, repeated exactly — including whether the chips apply
     to it. A cohort read through a different door would be a different set. */
  const payload = await (c.chips ? q(c.source) : qAll(c.source));
  const rows = membersOf(key, payload);
  /* Skeletons are REPLACED, not appended past. verdict() and foldRows() both
     append, so leaving the placeholders in place renders a finished page with
     a spinner still turning above it — which is what a reader reads as "this
     never loaded". */
  vHost.innerHTML = '';
  tblP.body.innerHTML = '';
  const ids = [...new Set(rows.flatMap((r) => (c.kind === 'vehicle'
    ? [r.plate] : accountsOf(r))).filter(Boolean))];

  verdict(vHost, {
    claim: rows.length
      ? `${countOf(rows.length, c.kind === 'vehicle' ? 'vehicle' : 'person')} — ${c.label.toLowerCase()}`
      : `Nobody is ${c.label.toLowerCase()} in this window`,
    figure: fmt(rows.length),
    unit: c.kind === 'vehicle' ? plural(rows.length, 'vehicle') : plural(rows.length, 'person', 'people'),
    tone: rows.length ? 'warn' : 'good',
    sub: `${c.question} ${c.why}`,
    meta: `from ${c.fromLabel}`,
  });

  /* What the SET is worth, before the members. A reader arriving from a tile
     knows the count already — what they do not know is whether these thirty
     three cars are a rounding error or a third of the fleet's idle days. Built
     from the rows the source already returned, so it adds no request and can
     never disagree with the table below it.

     Every tile is conditional on its field EXISTING in the rows, not on the
     value: the asset ledger carries no tracker column and the directory
     carries no idle-day one, and a tile reading "No tracker fix 0" over rows
     that were never asked the question is a confident answer to something
     nobody measured. */
  const all = (c.pick ? payload?.[c.pick] : payload) || [];
  const has = (f) => rows.some((r) => r[f] !== undefined);
  const near = (f) => rows.filter((r) => r[f] != null && r[f] < 30).length;
  const over = (f) => rows.some((r) => r[f] != null && r[f] < 0);
  kpiHost.replaceWith(kpiRow([
    { label: c.kind === 'vehicle' ? plural(rows.length, 'Vehicle') : plural(rows.length, 'Person', 'People'),
      value: fmt(rows.length),
      sub: all.length ? `of ${fmt(all.length)} the source listed` : null },
    { label: 'Bookings', value: fmt(sumOf(rows, (r) => r.trips ?? r.bookings)),
      sub: `${fmt(sumOf(rows, (r) => r.km))} km` },
    /* For a set defined by having earned nothing, what it COST is the number
       worth printing — the asset ledger already computes it at each car's own
       daily rate, which is honest in a way a fleet average would not be. */
    has('forgone_at_own_rate') && !sumOf(rows, (r) => r.money)
      ? { label: 'Forgone', value: money(sumOf(rows, (r) => r.forgone_at_own_rate)), tone: 'warn',
          sub: 'at each asset’s own daily rate — unearned, not lost' }
      : { label: 'Money', value: money(sumOf(rows, (r) => r.money ?? r.revenue ?? r.payout)),
          sub: 'across the whole set' },
    has('idle_days')
      ? { label: 'Idle days', value: fmt(sumOf(rows, (r) => r.idle_days)), tone: 'warn',
          sub: 'days in this window with nothing at all' }
      : has('days_worked') || has('days')
        ? { label: 'Days worked', value: fmt(sumOf(rows, (r) => r.days_worked ?? r.days)),
            sub: 'person-days inside the window' }
        : null,
    has('measured_hours_online')
      ? { label: 'Online', value: `${fmt(sumOf(rows, (r) => r.measured_hours_online), 0)} h`,
          sub: 'measured, where availability was collected' } : null,
    has('doc_days_left')
      ? { label: 'Papers due', value: fmt(near('doc_days_left')),
          sub: 'expiring within 30 days', tone: over('doc_days_left') ? 'critical' : null } : null,
    has('licence_days_left')
      ? { label: 'Licences due', value: fmt(near('licence_days_left')),
          sub: 'expiring within 30 days', tone: over('licence_days_left') ? 'critical' : null } : null,
    has('last_fix')
      ? { label: 'No tracker fix', value: fmt(rows.filter((r) => !r.last_fix).length),
          sub: 'nothing can say where they are' } : null,
  ]));

  if (!rows.length) {
    empty(tblP.body, 'Nothing matches in this window');
    empty(cardsP.body, 'Nothing to show');
    return { label: c.label, from: c.from, fromLabel: c.fromLabel, n: 0 };
  }

  /* The scanning table first — the same columns the source page ranked on, so
     a reader arriving from a tile sees the numbers they clicked.

     Normalised into a fixed shape before it is rendered. Four different
     endpoints feed this page and each names the same fact differently — the
     asset ledger says `money`, the directory says `revenue` and `payout`; the
     roster says `trips` and `category` where the ledger says `bookings` and
     `state`. A render function can paper over that and the SORT cannot, and
     neither can `absent`: a column keyed on a field these particular rows do
     not carry is pruned as empty and the page prints "no provider describes
     the standing of anybody here" over a list of people every provider has
     described. */
  const view = rows.map((r) => (c.kind === 'vehicle' ? {
    ...r,
    n_bookings: r.trips ?? r.bookings ?? 0,
    n_journeys: r.telematics_journeys ?? null,
    n_money: r.money ?? r.revenue ?? r.payout ?? null,
  } : {
    ...r,
    n_bookings: r.bookings ?? r.trips ?? 0,
    n_money: r.money ?? r.payout ?? r.revenue ?? null,
    n_days: r.days_worked ?? r.days ?? null,
    n_online: r.measured_hours_online ?? null,
    standing: r.state || r.category || null,
    channels: (r.platforms || []).map(sourceLabel).join(', ') || null,
  }));

  const cols = c.kind === 'vehicle'
    ? [
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Make & model', key: 'make',
        render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—'),
        absent: 'No vehicle here is in the fleet register.' },
      { label: 'Bookings', key: 'n_bookings', num: true },
      { label: 'Journeys', key: 'n_journeys', num: true,
        absent: 'No tracker journey is counted on this list.' },
      { label: 'Money', key: 'n_money', num: true, render: (r) => money(r.n_money),
        absent: 'None of these earned anything.' },
      { label: 'Idle days', key: 'idle_days', num: true,
        absent: 'Idle days are not computed on this list.' },
      { label: 'Papers', key: 'doc_days_left', num: true,
        render: (r) => (r.doc_days_left == null ? '—'
          : r.doc_days_left < 0 ? pill(`expired ${fmt(-r.doc_days_left)} d`, 'bad')
            : r.doc_days_left < 30 ? pill(`${fmt(r.doc_days_left)} d`, 'warn')
              : `${fmt(r.doc_days_left)} d`),
        absent: 'No document on any of these carries an expiry date.' },
      { label: 'Held by', key: 'current_driver',
        render: (r) => entity('driver', r.current_driver_id, r.current_driver || '—'),
        absent: 'Nobody is recorded as holding any of these.' },
    ]
    : [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', idOf('driver', r), r.driver_name || r.name || '—') },
      { label: 'Channels', key: 'channels',
        absent: 'No channel is named on any of these people.' },
      { label: 'Bookings', key: 'n_bookings', num: true },
      { label: 'Money', key: 'n_money', num: true, render: (r) => money(r.n_money),
        absent: 'None of these was paid anything.' },
      { label: 'Days worked', key: 'n_days', num: true,
        absent: 'No day count reaches this list.' },
      { label: 'Online h', key: 'n_online', num: true, render: (r) => fmt(r.n_online, 0),
        absent: 'Availability was not collected for anybody on this list.' },
      { label: 'Standing', key: 'standing',
        absent: 'No provider describes the standing of anybody here.' },
      { label: 'Licence', key: 'licence_days_left', num: true,
        render: (r) => (r.licence_days_left == null ? '—'
          : r.licence_days_left < 0 ? pill(`expired ${fmt(-r.licence_days_left)} d`, 'bad')
            : r.licence_days_left < 30 ? pill(`${fmt(r.licence_days_left)} d`, 'warn')
              : `${fmt(r.licence_days_left)} d`),
        absent: 'No licence date is recorded for anybody here.' },
    ];
  foldRows(tblP.body, tableFrom(view, cols, { compact: true, sortable: true, sortId: 'coh' }),
    { shown: 12, total: rows.length, noun: c.kind === 'vehicle' ? 'vehicle' : 'person', key: `cohort-${key}` });

  /* The all-source join. One request for the whole cohort, not one per member
     — which is the difference between this page and opening 33 of them. */
  const path = c.kind === 'vehicle' ? '/api/cohort/vehicles' : '/api/cohort/drivers';
  const detail = await api(`${path}?${c.chips ? params({ ids: ids.join(',') })
    : unfiltered({ ids: ids.join(',') })}`).catch(() => null);
  cardsP.body.innerHTML = '';
  if (!detail || !(detail.rows || []).length) {
    empty(cardsP.body, 'Could not gather the other sources for this set');
  } else {
    const byId = new Map(detail.rows.map((r) => [c.kind === 'vehicle' ? r.plate : r.id, r]));
    const box = el('div', 'cohort-cards');
    /* A person keys on several provider accounts; their card merges what each
       of those accounts was told, because the roster fold already decided the
       accounts are one human. */
    for (const r of rows) {
      const one = c.kind === 'vehicle'
        ? byId.get(r.plate)
        : mergeAccounts(accountsOf(r).map((x) => byId.get(x)).filter(Boolean));
      memberCard(box, c.kind, r, one);
    }
    /* Folded: a hundred and twenty-six cards is a page nobody scrolls, and the
       table above is what a reader uses to pick which of them to read. */
    foldChildren(cardsP.body, box, { shown: 6, total: rows.length,
      noun: c.kind === 'vehicle' ? 'vehicle' : 'person', key: `cohort-cards-${key}` });
    if (ids.length >= 400) {
      cardsP.body.append(note('This set is larger than the 400 the detail join will gather at once, '
        + 'so the cards below cover the first 400. The table above is complete.', 'warn'));
    }
  }
  return { label: c.label, from: c.from, fromLabel: c.fromLabel, n: rows.length };
}

/* Two provider accounts, one human. Arrays concatenate; availability is summed
   because driver_day is keyed on the account and a person driving under two of
   them was online for the sum of both. */
export function mergeAccounts(list) {
  if (list.length <= 1) return list[0] || null;
  const out = { id: list[0].id, work: [], pay: [], standing: [], compliance: [],
    cars: [], alerts: [], performance: [], not_completed: [], availability: null };
  for (const d of list) {
    for (const k of ['work', 'pay', 'standing', 'compliance', 'cars', 'alerts', 'performance', 'not_completed']) {
      out[k] = out[k].concat(d[k] || []);
    }
    if (d.availability) {
      out.availability = out.availability || { days: 0, online_min: 0, idle_min: 0, on_job_min: 0 };
      for (const k of ['days', 'online_min', 'idle_min', 'on_job_min']) {
        out.availability[k] = (Number(out.availability[k]) || 0) + (Number(d.availability[k]) || 0);
      }
    }
  }
  out.alerts.sort((a, b) => b.n - a.n);
  out.cars.sort((a, b) => b.days - a.days);
  out.not_completed.sort((a, b) => b.n - a.n);
  return out;
}
