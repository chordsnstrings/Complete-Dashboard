/* CHARGING — what the company has paid for on a driver's behalf, and the four
   reasons nothing here can be reconciled against a meter.
   ─────────────────────────────────────────────────────────────────────────
   The operator: "Loans are in Cash Advance format, Salary Advance format,
   Charging Advance format." And, about this one specifically: "drivers charge
   outside of our network as well. So we won't have complete overview."

   So this page has two halves and they are not the same kind of thing. The
   ledger half is RECORDED and exact: somebody typed it, attributed it, and
   attached a photograph. The reconciliation half does not exist, and the
   honest thing — the thing this whole dashboard is for — is to say precisely
   what is missing and why, rather than leave a reader to assume the recorded
   figure has been checked against something.

   ── WHY THERE IS NO REPAYMENT ON THIS PAGE ───────────────────────────────
   The ledger records a repayment against the PERSON, not against a particular
   advance. Nothing in it knows whether a driver's AED 300 repaid a charging
   advance, a cash advance or a salary advance. Showing repayments here would
   imply an offset nothing can support — so the form offers charging advances
   only, the page says why, and repayments stay on #advances where they are
   about the person's whole balance and that is what they actually mean.

   ── AND WHY THE IDLE FIGURE ON #supply IS NOT EVIDENCE ───────────────────
   api/supply_routes.js has chargingSiteOf(), and test/charging.test.mjs pins
   exactly how narrow it is: it matches the AREA NAME a car was left in against
   a configured list of areas that contain a charger. It can say "this car was
   left somewhere that has a charger". It can never say "this car charged", let
   alone who was in it. Putting it beside a money figure would turn a caveat
   into a claim, so it is named here as the thing it is not. */
import { el, esc, panel, note, loading, tableFrom, kpiRow, entity, empty,
  contract, glance, absenceBand, pageFoot, dtStr } from './ui.js';
import { fmt } from './charts.js';
import { ledgerBand, formBars } from './ledger_ak.js';
import { qAll, windowLabel, href, personAddr } from './data.js';
import { entryForm } from './entry_form.js';
import { aed, loadPeople } from './deposit_core.js';
import { post } from './access.js';

/* CHARGING ADVANCES ONLY. A repayment is not charging-specific — see the head
   of this file — and offering one here would record an offset against a
   particular advance that the ledger does not model. */
const TYPES = [
  { code: 'charging_advance', label: 'Charging advance',
    hint: 'Charging paid for on the driver’s behalf. Always a human entry: a charger meters a '
      + 'vehicle, and nothing in this building records who was in one.' },
];

/* ── PowerDrive: the wallets, the queue, charging by car ──────────────────
   The operator, 2026-11-03: "show charging wallet balance for the drivers
   that we have … we need to be very precise", then "we can track how many
   times each vehicles are charging". Read by src/sources/yocharge.js every six
   hours from PowerDrive (a YoCharge white label); served by
   api/charging_routes.js. A wallet is a named driver's money, shown only
   where the link is certain or a person confirmed it — everything else waits
   in "Wallets to confirm", with its reason. A charge is a session that
   delivered energy; each one is put on a car by its own plate, the only car
   the driver drove that day, or the nearest booking, and the table says
   which. Only PowerDrive's network is seen: a charge elsewhere is not here. */
const BASIS_WORD = { session_plate: 'its own plate', only_car: 'the only car driven that day', nearest_trip: 'the nearest booking' };
const when = (t) => (t ? dtStr(t) : '—');
function drawWallets(host, w) {
  host.innerHTML = '';
  if (!w || w._err || (!w.why && !w.totals)) { host.append(note(esc(`The charging wallets could not be read: ${w?._err?.message || 'the answer was not the shape this page reads'}`), 'bad')); return; }
  if (w.why) { host.append(note(esc(w.why), 'warn')); return; }
  const t = w.totals;
  host.append(kpiRow([
    { label: 'Drivers with a linked wallet', value: fmt(t.linked_people),
      sub: `${fmt(t.auto)} linked automatically, ${fmt(t.confirmed)} confirmed by a person` },
    { label: 'Balance, all linked wallets', value: aed(t.balance) || '—', sub: `AED, as PowerDrive holds it — ${fmt(t.nonzero)} not zero` },
    { label: 'Below zero', value: fmt(t.negative), sub: t.negative ? 'owing PowerDrive for charging already done' : 'none owing' },
    { label: 'On the fleet wallet', value: fmt(t.on_fleet_wallet), sub: 'charging against a company limit, not their own balance' },
    { label: 'To confirm', value: fmt(t.review + t.unplaced), sub: `${fmt(t.review)} suggested links, ${fmt(t.unplaced)} fleet customers we cannot place` },
  ]));
  host.append(tableFrom(w.rows, [
    { label: 'Driver', key: 'name', render: (r) => `<a class="lnk" href="${href('driver', personAddr(r.person_id))}">${esc(r.name || `person ${r.person_id}`)}</a>` },
    { label: 'Balance', key: 'balance', num: true, render: (r) => (r.balance == null ? '<span class="dim">—</span>'
      : `<span class="${r.balance < 0 ? 'bad' : ''}">${esc(aed(r.balance))}</span>`) },
    { label: 'On hold', key: 'hold_amount', num: true, render: (r) => esc(r.hold_amount ? aed(r.hold_amount) : '—') },
    { label: 'Fleet wallet', key: 'fleet_limit_available', num: true,
      render: (r) => (r.using_fleet_wallet ? `${esc(aed(r.fleet_limit_available) || '—')} <span class="dim">left of the limit</span>` : '<span class="dim">own wallet</span>') },
    { label: 'Last charge', key: 'last_session_at', render: (r) => esc(when(r.last_session_at)) },
    { label: 'Charges, 30 days', key: 'charges_30d', num: true, render: (r) => esc(fmt(r.charges_30d)) },
    { label: 'Linked', key: 'tier', render: (r) => esc(r.tier === 'confirmed' ? 'confirmed' : 'automatic') },
  ], { sortable: true, sortId: 'pdw', defaultSort: { key: 'balance', dir: 'asc' }, cards: true, cardLead: 'name' }));
  host.append(el('p', 'cap', esc(`From PowerDrive, read every six hours — last read ${when(w.synced_at)} Dubai: `
    + `${w.customers_read ? `${fmt(w.customers_read)} customers read, ` : ''}${fmt(w.customers)} kept — those in our fleet groups there `
    + 'or matching one of our drivers; nobody else\u2019s details are stored. A wallet is linked automatically only when its mobile belongs to exactly '
    + 'one of our drivers and one PowerDrive customer and the two names share a word; every other possible match waits below '
    + 'for a person. A driver with no linked wallet is not on this list, rather than shown with AED 0.')));
}
function drawReview(host, w, again) {
  host.innerHTML = '';
  if (!w || w._err || w.why || !Array.isArray(w.review)) { host.append(el('p', 'cap', esc(w?.why || 'Nothing to confirm until PowerDrive has been read.'))); return; }
  if (!w.review.length && !w.unplaced.length) { host.append(el('p', 'cap', 'Nothing waiting: every PowerDrive customer we can see is linked, refused, or not one of ours.')); return; }
  if (w.review.length) {
    const ul = el('ul', 'bul pd-review');
    for (const r of w.review) {
      const li = el('li');
      li.innerHTML = `PowerDrive's <b>${esc(r.yc_name || 'unnamed customer')}</b>${r.yc_phone ? ` (${esc(r.yc_phone)})` : ''}`
        + `${r.yc_fleet_group ? ` in ${esc(r.yc_fleet_group)}` : ''} — is it our <b>${esc(r.our_name || `person ${r.person_id}`)}</b>? `
        + `<span class="dim">${esc(r.reason)}.</span> `;
      const yes = el('button', 'btn sm', 'Same person');
      const no = el('button', 'btn sm ghost', 'Not this person');
      const msg = el('span', 'cap');
      const decide = async (decision) => {
        yes.disabled = true; no.disabled = true; msg.textContent = ' Saving…';
        try { await post('/api/charging/link', { yc_user_id: r.yc_user_id, person_id: Number(r.person_id), decision }); await again(); }
        catch (e) { msg.textContent = ` ${e.message}`; yes.disabled = false; no.disabled = false; }
      };
      yes.addEventListener('click', () => decide('confirm'));
      no.addEventListener('click', () => decide('refuse'));
      li.append(yes, ' ', no, msg);
      ul.append(li);
    }
    host.append(ul);
  }
  if (w.unplaced.length) {
    const d = el('details', 'pd-unplaced');
    const n = w.unplaced.length;
    d.innerHTML = `<summary class="cap">${esc(`${fmt(n)} PowerDrive ${n === 1 ? 'customer' : 'customers'} in our fleet groups `
      + `${n === 1 ? 'matches' : 'match'} none of our drivers by mobile, email or name — a driver who has left, or one registered `
      + 'with a number we do not hold')}</summary>`
      + `<p class="cap">${w.unplaced.map((u) => `${esc(u.yc_name || 'unnamed')} <span class="dim">${esc(u.yc_phone || '')} · ${esc(u.yc_fleet_group)}</span>`).join(' · ')}</p>`;
    host.append(d);
  }
  host.append(el('p', 'cap', 'Confirming says the PowerDrive customer IS that driver; it needs a signed-in Owner, Management or HR '
    + 'officer — whoever decides same-person pairs. Refusing keeps the pair from being offered again. A run never changes either.'));
}
function drawCars(host, s) {
  host.innerHTML = '';
  if (!s || s._err || (!s.why && !s.totals)) { host.append(note(esc(`Charging sessions could not be read: ${s?._err?.message || 'the answer was not the shape this page reads'}`), 'bad')); return; }
  if (s.why) { host.append(note(esc(s.why), 'warn')); return; }
  const t = s.totals;
  const b = t.basis;
  host.append(kpiRow([
    { label: `Charges, ${s.from} to ${s.to}`, value: fmt(t.charges), sub: `${fmt(t.no_energy)} more sessions delivered no energy and are not counted` },
    { label: 'Energy', value: `${fmt(t.kwh)} kWh`, sub: 'PowerDrive counts watt-hours; shown in kWh' },
    { label: 'Paid', value: aed(t.cost) || '—', sub: 'AED, VAT included, as each session’s payment states it' },
    { label: 'Put on a car', value: `${fmt(t.on_a_car)} of ${fmt(t.charges)}`,
      sub: `${fmt(b.session_plate)} by their own plate, ${fmt(b.only_car)} the only car driven that day, ${fmt(b.nearest_trip)} the nearest booking` },
  ]));
  host.append(tableFrom(s.vehicles, [
    { label: 'Car', key: 'plate', render: (v) => `<a class="lnk" href="${href('vehicle', v.plate)}">${esc(v.plate)}</a>` },
    { label: 'Charges', key: 'charges', num: true, render: (v) => esc(fmt(v.charges)) },
    { label: 'kWh', key: 'kwh', num: true, render: (v) => esc(fmt(v.kwh)) },
    { label: 'AED', key: 'cost', num: true, render: (v) => esc(aed(v.cost) || '—') },
    { label: 'Minutes', key: 'minutes', num: true, render: (v) => esc(fmt(v.minutes)) },
    { label: 'Last charged', key: 'last_at', render: (v) => esc(when(v.last_at)) },
    { label: 'Drivers', key: 'drivers', num: true, render: (v) => esc(fmt(v.drivers)) },
    { label: 'How it was put on this car', key: 'charges',
      render: (v) => esc(Object.entries(v.basis).filter(([, k]) => k).map(([k, n2]) => `${fmt(n2)} ${BASIS_WORD[k]}`).join(' · ')) },
  ], { sortable: true, sortId: 'pdc', defaultSort: { key: 'charges', dir: 'desc' }, cards: true, cardLead: 'plate' }));
  const off = (b.no_trip || 0) + (b.no_link || 0) + (b.not_yet || 0);
  host.append(el('p', 'cap', esc(`${fmt(off)} charges are on no car: ${fmt(b.no_trip)} by a linked driver who drove no car that day, `
    + `${fmt(b.no_link)} by a PowerDrive customer in our fleet groups linked to none of our drivers`
    + `${b.not_yet ? `, ${fmt(b.not_yet)} not yet worked out` : ''}. Only PowerDrive's network is seen: a charge anywhere else is not here.`)));
}
async function powerDrive(root, before) {
  const wal = panel('Charging wallets — PowerDrive', null, 'charging-wallets');
  const rev = panel('Wallets to confirm', null, 'charging-review');
  const cars = panel('Charging by car — PowerDrive', null, 'charging-cars');
  for (const p of [wal, rev, cars]) { root.insertBefore(p.panel, before); loading(p.body); }
  const read = async () => {
    const [w, s] = await Promise.all([
      qAll('/api/charging/wallets').catch((e) => ({ _err: e })),
      qAll('/api/charging/sessions').catch((e) => ({ _err: e })),
    ]);
    drawWallets(wal.body, w);
    drawReview(rev.body, w, read);
    drawCars(cars.body, s);
    return s;
  };
  return read();
}
/* What the page may say about a meter now that PowerDrive's sessions are read
   — or why it still cannot. */
const pdRead = (pd) => !!(pd && !pd._err && !pd.why && pd.totals);
const meterSentence = (pd) => (pdRead(pd)
  ? `Every figure above was typed by a person, and none of it is reconciled against a meter. PowerDrive’s charging sessions are read now — ${fmt(pd.totals.charges)} charges over ${pd.from} to ${pd.to}, at the top of this page — but matching an advance to them is not built: only PowerDrive’s network is seen, and a charger meters a car while an advance is owed by a person.`
  : `Every figure above was typed by a person. None of it has been checked against a charging meter: ${pd?.why || 'PowerDrive’s charging sessions could not be read'}`);

export async function renderCharging(root) {
  root.innerHTML = '';
  /* NOT "Charging" — that is the rail's label for this view and the shell
     already prints it. test/nav_sections.test.mjs exists because a page that
     repeats its own name spends the one line a reader gives it saying nothing
     they did not already know. */
  const head = panel('What has been advanced', null, 'charging');
  const formPanel = panel('Record one', null, 'charging-form');
  const whoPanel = panel('Who has had what', null, 'charging-people');
  const regPanel = panel('Every entry, most recent first', null, 'charging-register');
  const gapPanel = panel('What none of this is checked against', null, 'charging-gap');
  /* Under the page contract (plan §4 #charging): 00 in place of the tile
     panel; Record one, Who has had what and Every entry where they were;
     then both sides of the reconciliation, and the gap panel becomes the †
     band — every bullet's full text and the Supply link kept. */
  const ak = contract();
  const AK = ak ? ledgerBand(windowLabel()) : null;
  const both = ak ? panel('Both sides of this reconciliation', 'The people a charging advance can be recorded against, '
    + 'the ones who have one, and the charging sessions to check them against.', 'charging-sides') : null;
  const absHost = ak ? el('div') : null;
  if (ak) root.append(AK.band, formPanel.panel, whoPanel.panel, regPanel.panel, both.panel, absHost);
  else root.append(head.panel, formPanel.panel, whoPanel.panel, regPanel.panel, gapPanel.panel);
  loading(ak ? AK.tiles : head.body);
  /* PowerDrive straight under the page's own summary (the 00 band, or the
     old skin's tiles): the wallets and the cars, then the hand-kept register
     and its form. */
  const pdP = powerDrive(root, formPanel.panel);

  async function refresh() {
    /* qAll, not a hand-built query string: it carries the shell's own window
       and drops the platform/fleet chips, which /api/ledger/entries does not
       take. A page that parsed the hash itself would be a second reading of
       the same control, free to disagree with the label printed above it. */
    const [reg, dir] = await Promise.all([
      qAll('/api/ledger/entries', { type_code: 'charging_advance' }).catch(() => null),
      loadPeople(),
    ]);
    head.body.innerHTML = '';
    whoPanel.body.innerHTML = '';
    regPanel.body.innerHTML = '';

    if (!reg) {
      (ak ? AK.tiles : head.body).append(note('The charging register could not be read.', 'bad'));
      return;
    }

    const t = reg.totals;
    const people = reg.by_person || [];
    if (ak) chargingContract(AK, both, reg, dir, await pdP);
    else head.body.append(kpiRow([
      /* ABSENT, NOT NOUGHT. This fell back to the literal 'AED 0.00' when
         totals.advance came back null — and null is what /api/ledger/entries
         sends when no charging row exists in the window at all (a sum over
         no rows), not a sum of rows that came to nought. The register is
         written by hand and checked against no meter, so an empty window
         means nobody recorded a charging advance in these dates. It does not
         mean the fleet advanced nothing, and a bold "AED 0.00" said it did.
         The value is now a dash and the sub-line says why. */
      { label: `Advanced in ${windowLabel()}`, value: aed(t.advance) || '—',
        sub: t.advance == null
          ? 'nothing has been recorded for charging in these dates — the register is kept by '
            + 'hand, so this is no record, not a measured nought'
          : 'recorded by hand, and checked against no meter — see the last panel' },
      { label: 'Drivers', value: String(people.length),
        sub: people.length ? 'who have had a charging advance in this window'
          : 'nobody has had one in this window' },
      { label: 'Entries', value: String(t.rows),
        sub: t.verification_rows
          ? `${t.verification_rows} of them a verification row, excluded from the figures`
          : 'each with a photograph of its proof' },
    ]));
    /* The window governs BOTH halves of this page, which is the honest case —
       unlike a balance, "what have we advanced for charging" is a question
       about a span. Said rather than assumed. */
    if (!ak) {
      head.body.append(el('p', 'cap', `Both figures above and both tables below are over `
        + `${esc(windowLabel())}. Unlike a driver's balance, what a fleet has advanced for `
        + 'charging is a question about a span of dates, so the window is the right control for '
        + 'it and changing it changes everything on this page.'));
    }

    /* ── the form, mounted once ─────────────────────────────────────────── */
    if (!formPanel.body.querySelector('.depform')) {
      formPanel.body.innerHTML = '';
      if (!dir.ok) {
        formPanel.body.append(note(esc(dir.error), 'bad'));
      } else {
        entryForm(formPanel.body, {
          types: TYPES,
          people: (dir.people || []).filter((p) => p.name),
          settlesVia: 'charging',
          onSaved: refresh,
        });
        formPanel.body.append(el('p', 'cap', 'A repayment is not recorded here. The ledger '
          + 'records a repayment against the PERSON and not against a particular advance, so '
          + 'one entered on this page would imply it paid off a charging advance specifically '
          + '— which nothing in this database knows. Repayments are on '
          + `<a class="lnk" href="${href('advances')}">Advances</a>, where they are about the `
          + 'whole balance, which is what they actually mean.'));
      }
    }

    /* ── who has had what ───────────────────────────────────────────────── */
    if (!people.length) {
      /* Under the contract: over the dates the register ANSWERED, not the
         ones the control bar asked for (they differed — S5). */
      empty(whoPanel.body, ak ? `No charging advance has been recorded over ${spanOf(reg)}.`
        : `No charging advance has been recorded in ${windowLabel()}.`);
    } else {
      whoPanel.body.append(tableFrom(people, [
        { label: 'Driver', key: 'person_name',
          /* entity(), not a bare name — test/interlinking.test.mjs: a column
             whose label names a thing must be able to OPEN it. A person with
             no account degrades to plain text rather than a broken link. */
          render: (r) => entity('driver', r.ext_id, r.person_name) },
        { label: 'Advanced', key: 'out', num: true,
          render: (r) => `<b>${esc(aed(r.out) || '—')}</b>` },
        { label: 'Entries', key: 'entries', num: true, render: (r) => esc(String(r.entries)) },
        { label: 'Most recent', key: 'last_on', render: (r) => esc(r.last_on || '—') },
      ], { cards: true, cardLead: 'person_name' }));
    }

    /* ── the register ───────────────────────────────────────────────────── */
    if (!reg.entries.length) {
      empty(regPanel.body, 'Nothing recorded in these dates.');
    } else {
      if (reg.listed_why) regPanel.body.append(note(reg.listed_why, 'warn'));
      regPanel.body.append(tableFrom(reg.entries, [
        { label: 'When', key: 'effective_on', render: (e) => esc(e.effective_on) },
        { label: 'Driver', key: 'person_name',
          render: (e) => entity('driver', e.ext_id, e.person_name) },
        { label: 'Amount', key: 'amount', num: true,
          render: (e) => `<b>${esc(aed(e.amount))}</b>` },
        { label: 'Proof', key: 'proof',
          /* Three states, not two: held, held-until-a-date-and-since-gone, and
             a type that never has one. Collapsing them makes an expired
             photograph read as an entry nobody documented. */
          render: (e) => (e.receipt?.held
            ? `<a class="lnk" href="/api/ledger/receipt/${esc(e.receipt.sha256)}" target="_blank" `
              + 'rel="noopener">photograph</a>'
            : `<span class="dash" title="${esc(e.receipt?.absent_reason || '')}">—</span>`) },
        { label: 'Recorded by', key: 'entered_by',
          render: (e) => `${esc(e.entered_by)} <span class="dim">`
            + `${esc(String(e.entered_at || '').slice(0, 10))}</span>` },
        { label: 'Note', key: 'note', render: (e) => esc(e.note || '—') },
      ], { cards: true, cardLead: 'person_name' }));
    }
  }

  await refresh();
  const pd = await pdP;
  if (ak) { chargingGap(absHost, root, pd); return; }

  /* ── the panel this page exists for ─────────────────────────────────── */
  gapPanel.body.append(note(esc(meterSentence(pd)), 'warn'));

  gapPanel.body.append(el('p', 'cap', 'What would have to happen, and what still would not:'));
  /* ul.bul — the class app.css actually styles (2372-2374), and the one
     #performance and #driver/record use for exactly this shape of list. An
     invented class name renders as an unstyled browser default, which reads as
     a page somebody forgot rather than one that is saying something. */
  const ul = el('ul', 'bul');
  const li = (h) => { const x = el('li'); x.innerHTML = h; return x; };
  ul.append(
    li('<b>Charging off PowerDrive\u2019s network exists upstream too.</b> Tesla serves past sessions at '
      + '<code>/api/1/dx/charging/history</code>, and energy with pricing at '
      + '<code>/api/1/dx/charging/sessions</code> — the second to business fleet owners only, '
      + 'which this fleet is. So that gap is access, not availability.'),
    li('<b>The token cannot be renewed from this server.</b> The stored one expired on '
      + '2026-09-10, and Tesla’s auth edge answers this platform’s egress with an HTML 403 '
      + 'before OAuth sees the request. Measured. It has to be minted from a machine Tesla '
      + 'answers, with <code>bin/tesla-token.mjs</code>.'),
    li('<b>And billing gates it before any of that.</b> Tesla’s default spend limit is $0 and '
      + 'is raised only after a payment method is added — and the UAE is not on Tesla’s '
      + 'payment-supported country list. Every response below a 500 is billable, refusals '
      + 'included.'),
    li('<b>Even ingested, it would be partial.</b> In the operator’s own words, drivers charge '
      + 'outside our network as well — so a reconciliation would cover our chargers and quietly '
      + 'call everything else unexplained.'),
    li('<b>Even complete, it would not settle who owes it.</b> A charger meters a VEHICLE and an '
      + 'advance is owed by a PERSON. The custody record is the only bridge between the two, and '
      + 'it is an inference from time and plate rather than ground truth.'),
  );
  gapPanel.body.append(ul);

  gapPanel.body.append(note('The idle hours reported at charging sites on '
    + `<a class="lnk" href="${href('supply')}">Supply</a> are NOT evidence of charging, and must `
    + 'not be read as a check on this page. That figure matches the AREA NAME a car was left in '
    + 'against a list of areas that contain a charger. It can say a car was left somewhere with '
    + 'a charger. It cannot say the car charged, and it says nothing at all about who was in it.',
  'warn'));
}

/* ── #charging under the page contract ─────────────────────────────────────
   00: advanced in the window, the hero — ABSENT with the true reason where
   no charging row exists in it (a sum over no rows is not a nought) ·
   drivers with one, of everyone the form can point at · entries · a meter
   to check it against, none ingested. The window the page claims is the
   window the ANSWER covers: it says "the whole record" when the register
   answered with no dates (the route read only from/to until 2026-09-24 and
   answered "This month" with everything — the plan's FIX; S5).
   NOT ADOPTED: "the eighteen books" (no GET serves the registry, and it is
   not about charging); people per channel and channels per person (the
   identity page's question); a chart of the window asked against the window
   answered (fixed instead of drawn). */
const spanOf = (reg) => (reg.from || reg.to
  ? `${reg.from || 'the first entry'} to ${reg.to || 'today'}` : 'the whole record');
function chargingContract(AK, both, reg, dir, pd = null) {
  const t = reg.totals;
  const people = reg.by_person || [];
  const roster = (dir?.people || []).filter((p) => p.name).length;
  const span = spanOf(reg);
  glance(AK.tiles, [
    t.advance != null
      ? { label: `Advanced over ${span}`, value: aed(t.advance), hero: true,
        sub: 'recorded by hand, and checked against no meter — see the last band' }
      : { label: `Advanced over ${span}`, hero: true,
        na: `${reg.from || reg.to ? 'no charging advance is recorded in these dates' : 'no charging advance has ever been recorded'}`
          + ' — the register is kept by hand, so this is no record, not a measured nought' },
    { label: 'Drivers with one', value: dir?.ok ? `${fmt(people.length)} of ${fmt(roster)}` : fmt(people.length),
      sub: dir?.ok ? 'of everyone the form can record against' : 'the list of drivers could not be read, so there is no denominator' },
    { label: 'Entries', value: fmt(t.rows),
      sub: t.verification_rows ? `${fmt(t.verification_rows)} verification rows excluded from the figures`
        : 'each with a photograph of its proof' },
    pdRead(pd)
      ? { label: 'PowerDrive charges, to check it against', value: fmt(pd.totals.charges),
        sub: `over ${pd.from} to ${pd.to} — read, not yet reconciled with these advances` }
      : { label: 'A meter to check it against', na: `none read — ${pd?.why || 'PowerDrive\u2019s sessions could not be read'}` },
  ]);
  /* The band's own note too: it read the control bar's window before the
     answer arrived, and the answer may cover something else. */
  const hn = AK.band.querySelector('.sechd-note');
  if (hn) hn.textContent = reg.from || reg.to ? span : 'The whole record';
  AK.band.querySelector('.ch-span')?.remove();
  const cap = el('p', 'cap ch-span', esc(reg.from || reg.to
    ? `Everything on this page is over ${span}, the dates the register was asked for and answered over.`
    : 'The register answered over the whole record — every charging advance ever entered — so the figures above are not limited to the dates chosen in the control bar.'));
  AK.band.append(cap);

  both.body.innerHTML = '';
  formBars(both.body, [
    { label: 'People the form can point at', n: dir?.ok ? roster : 0, outline: !dir?.ok,
      why: dir?.ok ? '' : 'the list of drivers could not be read' },
    { label: 'With a charging advance', n: people.length },
    pdRead(pd)
      ? { label: 'With a PowerDrive charge in these dates', n: (pd.drivers || []).length }
      : { label: 'With a charging session', na: 'none read', why: pd?.why || 'PowerDrive\u2019s sessions could not be read' },
  ]);
  both.body.append(el('p', 'cap', esc(pdRead(pd)
    ? 'The third row counts drivers linked to a PowerDrive wallet who charged in these dates. Matching their charges to the advances above is not built: PowerDrive\u2019s network is the only one seen, and a charge is a car\u2019s while an advance is a person\u2019s.'
    : 'The third row has no count, not a count of nought: no charging session has been read, so the side a reconciliation would check against does not exist here.')));
}
/* The gap panel's five bullets and its Supply caveat, as the † band — the
   text is the old panel's, cell by cell, nothing dropped. */
function chargingGap(host, root, pd = null) {
  absenceBand(host, [
    { label: 'A meter to check it against', fig: null, none: pdRead(pd) ? 'Not reconciled' : 'None read', html: true,
      why: `${esc(meterSentence(pd))} `
        + '<b>Charging off PowerDrive\u2019s network exists upstream too.</b> Tesla serves past sessions at <code>/api/1/dx/charging/history</code>, and '
        + 'energy with pricing at <code>/api/1/dx/charging/sessions</code> — the second to business fleet owners only, '
        + 'which this fleet is. So the gap is access, not availability.' },
    { label: 'Why the access is not there', fig: null, none: 'Token expired', html: true,
      why: '<b>The token cannot be renewed from this server.</b> The stored one expired on 2026-09-10, and Tesla’s '
        + 'auth edge answers this platform’s egress with an HTML 403 before OAuth sees the request. Measured. It has to '
        + 'be minted from a machine Tesla answers, with <code>bin/tesla-token.mjs</code>. <b>And billing gates it before '
        + 'any of that.</b> Tesla’s default spend limit is $0 and is raised only after a payment method is added — and '
        + 'the UAE is not on Tesla’s payment-supported country list. Every response below a 500 is billable, refusals included.' },
    { label: 'Even with a feed', fig: null, none: 'Partial, and a car', html: true,
      why: '<b>Even ingested, it would be partial.</b> In the operator’s own words, drivers charge outside our network '
        + 'as well — so a reconciliation would cover our chargers and quietly call everything else unexplained. '
        + '<b>Even complete, it would not settle who owes it.</b> A charger meters a VEHICLE and an advance is owed by a '
        + 'PERSON. The custody record is the only bridge between the two, and it is an inference from time and plate '
        + 'rather than ground truth.' },
    { label: 'Idle hours at charging sites', fig: null, none: 'Not evidence', html: true,
      why: `The idle hours reported at charging sites on <a class="lnk" href="${href('supply')}">Supply</a> are NOT `
        + 'evidence of charging, and must not be read as a check on this page. That figure matches the AREA NAME a car '
        + 'was left in against a list of areas that contain a charger. It can say a car was left somewhere with a '
        + 'charger. It cannot say the car charged, and it says nothing at all about who was in it.' },
  ]);
  pageFoot({ colophon: ['Recorded by hand', 'Checked against no meter'] }, root);
}
