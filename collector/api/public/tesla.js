/* The Teslas, and the honest account of what Tesla will tell us about them.
   ──────────────────────────────────────────────────────────────────────────
   Eighty-two of the fleet's 273 plates are Teslas and every one of them is a
   car Tesla itself can answer about — it is the only manufacturer in this
   fleet with a first-party API. So this page exists to hold two different
   kinds of fact side by side without letting either wear the other's clothes:

     what OUR records say     model, VIN, which fleet — true right now, with no
                              grant and no network call
     what TESLA says          battery, location, software, odometer — absent
                              until somebody signs in, and absent WITH THE
                              REASON rather than as a zero or a dash

   The second half is the whole point of the page and it is currently empty.
   That is not a defect to hide behind a spinner: the application's own
   credentials authenticate the APP, not an account, and a partner token
   answers GET /api/1/vehicles with HTTP 200 and a count of ZERO. Measured, not
   inferred. Until a human with the Tesla account approves this app, every
   Tesla-native figure here is unmeasurable, and this page says so in the same
   plain English the rest of the product uses.

   WHY THE LIVE CALL IS BEHIND A BUTTON. /api/tesla/vehicles costs a request
   against a pay-as-you-go tier. A page that billed on every render would be a
   page nobody could leave open, so the fleet table renders from our own
   database on load and Tesla is only asked when a reader asks for it.

   ON THE SIGN-IN BUTTON BEING REACHABLE BY ANYONE. It is, and so is every
   other write in this product: api/admin_gate.js is deliberately held open
   while ADMIN_TOKEN is unset, on the operator's instruction, and
   test/admin_gate.test.mjs pins that choice rather than the safe one. Gating
   this one route alone would not close anything and would contradict a
   decision made on purpose elsewhere. When that gate closes, this route should
   close with it — it is the one route here that can REPLACE a stored token. */
import { el, esc, panel, loading, note, kpiRow, tableFrom, pill, fmt } from './ui.js';
import { api } from './data.js';

/* The four figures the page leads with, and one of them is a coverage figure
   rather than a count. `with_vin` is not decoration: a VIN is Tesla's own join
   key, so a car without one is a car we cannot ask Tesla about even after the
   grant lands. Leading with 82 alone would promise eighty-two answers. */
const heldTiles = (s) => {
  const t = s.teslas || [];
  const total = s.total_teslas || 0;
  const vin = t.reduce((a, r) => a + (r.with_vin || 0), 0);
  const byModel = (m) => (t.find((r) => (r.model || '') === m) || {}).plates || 0;
  return [
    { label: 'Teslas', value: fmt(total), sub: 'of 273 plates in the fleet' },
    { label: 'Model Y', value: fmt(byModel('Model Y')), sub: null },
    { label: 'Model 3', value: fmt(byModel('Model 3')), sub: null },
    /* The absent ones are named ON the tile that counts them, because a
       reader who sees "78" beside "82" will otherwise go looking for the
       four, and the answer is not something a filter can find. */
    { label: 'Reachable by VIN', value: fmt(vin),
      sub: vin < total
        ? `${fmt(total - vin)} carry no VIN, so Tesla cannot be asked about them`
        : 'every one of them' },
  ];
};

/* THE GRANT, WHICH IS THE ONLY THING BETWEEN THIS PAGE AND LIVE DATA.
   Three states, and they are not interchangeable: no client credentials at
   all, credentials but no account approval, and connected. The middle one is
   the one people misread as a broken integration, so it gets the longest
   sentence and the button that resolves it. */
function grantPanel(s) {
  const p = panel('Tesla account', 'What Tesla will answer about these cars, and what it needs first');
  const body = p.body;

  if (s.granted && s.live && s.live.ok) {
    body.append(el('p', 'cap', 'Connected. Tesla will answer for this account.'));
  } else if (s.granted) {
    /* Granted once and refusing now is a THIRD thing again — a stored token
       that has been revoked or has expired reads exactly like a missing one
       unless the refusal is quoted. */
    body.append(el('p', 'cap', 'A Tesla token is stored, and Tesla is refusing it.'));
    body.append(note(`Tesla answered: ${s.live && s.live.why ? s.live.why : 'no reason given'}. `
      + 'Signing in again replaces the stored token.'));
  } else {
    body.append(el('p', 'cap', 'Not connected, so nothing below comes from Tesla.'));
    /* The server's own sentence, not a copy of it. api/tesla_routes.js writes
       this once so the desktop and the phone cannot word it differently, and a
       page that paraphrased it here would be the second wording. */
    body.append(note(s.why || 'No reason was given.'));
  }

  if (!s.client_configured) {
    body.append(note('Paste the Tesla client id and secret into Settings first — without them '
      + 'this application cannot identify itself to Tesla at all, and no sign-in link can be '
      + 'built.'));
    return p;
  }

  /* The link is MINTED ON DEMAND rather than rendered with the page, because
     it carries a state this server issued and holds in memory for fifteen
     minutes. A link printed on page load is a link that is usually expired by
     the time anybody reads it. */
  const row = el('div', 'toolbar');
  const btn = el('button', 'btn', s.granted ? 'Sign in again' : 'Get the sign-in link');
  const out = el('div', 'tesla-link');
  row.append(btn);
  body.append(row, out);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.textContent = 'asking…';
    try {
      const r = await api('/api/tesla/connect');
      if (!r || !r.url) throw new Error((r && r.error) || 'no link was returned');
      out.innerHTML = '';
      out.append(el('p', null, esc(r.note || '')));
      /* Rendered as text a person can copy, not only as a link they can click.
         Whoever holds the Tesla account is very often not the person looking
         at this dashboard, and the useful thing is something they can paste
         into a message. */
      const a = el('a', 'tesla-url');
      a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = r.url;
      out.append(a);
      out.append(note(`This link stops working in ${r.expires_in_min} minutes, and also if the `
        + 'server restarts — both because the request it belongs to is held in memory rather '
        + 'than stored. Ask for a new one and nothing is lost.'));
    } catch (e) {
      out.textContent = '';
      out.append(note(`The link could not be built: ${String(e.message || e)}`));
    } finally { btn.disabled = false; }
  });
  return p;
}

/* WHAT WE HOLD, which is true with or without Tesla. Rendered from our own
   database on load, so the page is useful on its worst day. */
function heldPanel(s) {
  const p = panel('The fleet’s Teslas', 'From our own records — no Tesla call is made to draw this');
  const rows = (s.teslas || []).map((r) => ({
    ...r,
    /* The gap between plates and with_vin, per model, as its own column: it
       is the number that decides how much of this fleet the grant can ever
       cover, and folding it into a percentage would hide four cars. */
    no_vin: (r.plates || 0) - (r.with_vin || 0),
  }));
  if (!rows.length) {
    p.body.append(note('No vehicle in our records has a make of Tesla. Either the fleet holds '
      + 'none, or the make column has not been filled for them — the vehicle profile is the '
      + 'place to check.'));
    return p;
  }
  p.body.append(tableFrom(rows, [
    { label: 'Model', key: 'model' },
    { label: 'Cars', key: 'plates', num: true },
    { label: 'With a VIN', key: 'with_vin', num: true },
    { label: 'No VIN', key: 'no_vin', num: true,
      render: (r) => (r.no_vin ? pill(fmt(r.no_vin), 'warn',
        'A VIN is Tesla’s own join key. Without one this car cannot be matched to anything '
        + 'Tesla returns, and the grant will not change that.') : '—') },
    { label: 'Ecosine', key: 'ecosine', num: true },
    { label: 'Egari', key: 'egari', num: true },
  ], { sortable: true }));
  return p;
}

/* ASKED ONLY WHEN ASKED. See the header: this call bills. */
function livePanel(s) {
  const p = panel('What Tesla returns', 'Asked live, and only when you ask — this call is billed per request');
  if (!s.granted) {
    p.body.append(note('Nothing to ask with yet. Tesla answers an unapproved application with an '
      + 'empty list rather than an error, so this panel would show "no vehicles" and mean '
      + '"no permission" — which is why it refuses to make the call at all.'));
    return p;
  }
  const btn = el('button', 'btn', 'Ask Tesla now');
  const out = el('div');
  const bar = el('div', 'toolbar');
  bar.append(btn);
  p.body.append(bar, out);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.textContent = 'asking Tesla…';
    try {
      const r = await api('/api/tesla/vehicles');
      out.innerHTML = '';
      if (r && r.why) out.append(note(r.why));
      const rows = (r && r.vehicles) || [];
      if (!rows.length) return;
      out.append(tableFrom(rows, [
        { label: 'Name', key: 'display_name' },
        { label: 'VIN', key: 'vin' },
        /* Tesla's `state` is asleep/online/offline and it is a fact about the
           CAR'S RADIO, not about whether it is driving. Named so, because
           "offline" beside a car that is out earning would otherwise read as a
           fault. */
        { label: 'Radio', key: 'state',
          render: (x) => pill(esc(x.state || '—'), x.state === 'online' ? 'ok' : null,
            'Tesla reports whether the car’s modem is awake. A sleeping car is a normal '
            + 'parked car, not a fault.') },
      ], { sortable: true }));
    } catch (e) {
      out.textContent = '';
      out.append(note(`Tesla could not be reached: ${String(e.message || e)}`));
    } finally { btn.disabled = false; }
  });
  return p;
}

/* WHAT TESLA ACTUALLY HOLDS PER CAR, verified against Tesla's own docs on
   2026-09-10 rather than remembered.
   ──────────────────────────────────────────────────────────────────────────
   This panel replaces one that said "there is no trip, drive or odometer
   history in the Fleet API at all". That was wrong twice over and it was
   written with enough confidence to plan around:

     - the ODOMETER is a first-class live field, and two reads a day apart
       bound a day's distance — which is an independent check on the
       tracker-derived kilometres this dashboard already draws;
     - CHARGING HISTORY EXISTS. /api/1/dx/charging/history is paginated
       history, /api/1/dx/charging/sessions carries pricing and energy and is
       restricted to business fleet owners — which this fleet is — and
       /api/1/dx/charging/invoice/{id} returns the invoice PDF.

   What is genuinely absent is a per-DRIVE history: Tesla will not say where a
   car went last Tuesday. Everything else here accrues forward from the day it
   is switched on. Naming that precisely matters, because "no history" and "no
   trip history" lead to completely different decisions about what to build. */
function canPanel() {
  const p = panel('What Tesla can tell us about each car',
    'Verified against Tesla’s documentation, 2026-09-10 — none of it is being read yet');
  const g = (title, items) => {
    const h = el('p', 'cap', title);
    const ul = el('ul', 'tesla-limits');
    ul.innerHTML = items.map((i) => `<li>${i}</li>`).join('');
    p.body.append(h, ul);
  };
  g('Battery and charge', [
    '<b>State of charge</b> as a percentage, and the usable figure beside it — they differ, '
    + 'and the usable one is what a driver actually has.',
    '<b>Energy remaining in kWh</b> and the estimated range from it.',
    '<b>Charging state</b>, with a granular version on newer firmware, plus energy added by '
    + 'AC and by DC separately and lifetime energy used — which is cost per kilometre, per car, '
    + 'measured rather than modelled.',
  ]);
  g('Distance and movement', [
    '<b>Odometer.</b> A live reading, not a series — but two readings a day apart bound that '
    + 'day’s distance, and that is an independent check on the tracker kilometres this '
    + 'dashboard already draws.',
    '<b>Position, heading, speed and gear</b>, second by second on the streaming feed. A '
    + 'second opinion on CABMAN and FMS rather than a replacement for them.',
  ]);
  g('Condition', [
    '<b>Tyre pressure on each wheel</b>, with Tesla’s own hard and soft warnings. Nothing in '
    + 'this product reports that today.',
    '<b>Software version and update status</b>, and whether the car is locked, in sentry mode, '
    + 'or has a door or boot open.',
  ]);
  g('Money', [
    '<b>Charging history</b> — paginated past sessions, with pricing and energy on the '
    + 'business-fleet endpoint, and the invoice PDF for any one of them. This is the one place '
    + 'Tesla does give us the past.',
  ]);
  return p;
}

/* TWO WAYS IN, AND THEY ARE NOT ALTERNATIVES SO MUCH AS OPPOSITES. */
function routesPanel() {
  const p = panel('The two ways to get it', 'One is billed per look; the other is pushed to us');
  const ul = el('ul', 'tesla-limits');
  ul.innerHTML = `
    <li><b>Asking, per car, per look.</b> Tesla&rsquo;s own documentation says regularly polling
      this &ldquo;is not recommended and will be expensive&rdquo;. Worse for a working fleet: a
      parked car is asleep, and waking it needs the command scope this application
      deliberately did not ask for &mdash; so a sleeping car simply cannot be read, and
      wakes are capped at three a minute anyway.</li>
    <li><b>Fleet Telemetry, which Tesla recommends instead.</b> The car pushes its own fields
      to a server of ours over a mutually authenticated connection, as often as twice a
      second, with no polling and no waking. The cost is setup: a virtual key paired on
      <em>each</em> car, and both Model 3 and Model Y require the Vehicle Command Protocol, so
      that is 82 pairings a person has to do &mdash; automatic pairing will not cover them.</li>`;
  p.body.append(ul);
  return p;
}

/* THE SHARP EDGE. Stated as its own panel because it is the one that can cost
   money or silently break a feed after it is working. */
function costPanel() {
  const p = panel('What it costs, and how it breaks',
    'Worth settling before anybody pairs 82 cars');
  const ul = el('ul', 'tesla-limits');
  ul.innerHTML = `
    <li><b>Pay per use, and the default spend limit is $0.</b> It can only be raised after a
      payment method is added, and <b>the UAE is not on Tesla&rsquo;s payment-supported country
      list</b>. Somebody with the Tesla account should check for a &ldquo;Billing and Usage&rdquo;
      button before any of this is planned &mdash; that check is the gate on everything above.</li>
    <li><b>Every answer below a 500 is billable</b>, including the refusals. Only Tesla&rsquo;s
      own server errors are free.</li>
    <li><b>Going over the limit does not just pause billing.</b> Tesla suspends API access
      <em>and deletes the Fleet Telemetry configuration</em>, and its documentation says it
      &ldquo;will not be restored&rdquo; &mdash; so an overrun costs the 82 pairings, not just the
      month.</li>`;
  p.body.append(ul);
  return p;
}

export async function renderTesla(root) {
  root.innerHTML = '';
  loading(root);
  let s;
  try {
    s = await api('/api/tesla/status');
  } catch (e) {
    root.innerHTML = '';
    root.append(note(`The Tesla status could not be read: ${String(e.message || e)}`));
    return;
  }
  root.innerHTML = '';
  root.append(kpiRow(heldTiles(s)));
  root.append(grantPanel(s).panel);
  root.append(heldPanel(s).panel);
  root.append(livePanel(s).panel);
  root.append(canPanel().panel);
  root.append(routesPanel().panel);
  root.append(costPanel().panel);
}
