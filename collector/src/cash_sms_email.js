/* THE 08:00 CASH EMAIL — who was texted to deposit yesterday's cash.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-09-30: "send emails to [the cash desk] every morning at
   8 am with all the drivers who were supposed to deposit cash yesterday.
   Specifically the ones who got SMS. He should get name, phone number, amount
   of cash that needs to be deposited and from which specific platform."

   WHICH DAY. The 05:00 text (src/driver_sms.js cashDepositRun) says "Please
   deposit AED X of Uber, Bolt cash you received yesterday". So the email at
   08:00 on the 1st lists the drivers texted that morning about the cash they
   took on the 30th — the business_day of their sms_outbox row — which is the
   list of who should be coming in to deposit, and what, that same morning.

   WHERE EVERY FIGURE COMES FROM: the texts themselves. A row is a
   cash_deposit message the gateway accepted (sms_outbox status 'sent'); the
   name is driver.full_name, the mobile is the number it went to, the amount
   is the amount in the text, and the platforms are the ones the text named,
   with the split the run kept beside it (detail.by_channel, from 2026-09-30).
   Nothing is recomputed from trip_cash: a late fare moves that table and
   never the message, and the cash desk must hold the driver to what the
   driver was told.

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON:
     · cash on a channel the text left out (a channel that did not collect, a
       fare not final, a hotel account keyed by a name) is named under the
       driver, never folded into the amount;
     · a driver with cash who was NOT texted is counted by reason at the foot
       — the operator asked for the ones who got the text, not a second list;
     · when the text went but the gateway later reported it not delivered, the
       row says so;
     · a split by platform the run did not keep (texts before 2026-09-30 on
       two channels) is said to be unknown, not guessed.

   WHEN. The 05:00 run waits, every quarter hour until 09:00, for Uber's
   figures for the day to be complete, and texts nobody until they are. So
   at 08:00 the email goes if that run has finished; if not, it waits for it
   on each quarter hour and at 09:15 goes whatever the state, saying why the
   list is empty or short. One address gets one day's list once. */
import { http as realHttp } from './http.js';
import { get } from './settings.js';
import { log } from './log.js';
import { HOLD_WHY, addDays, dubaiStart } from './driver_sms.js';
import { yesterdayDubai, resendSend, EMAIL, T, SERIF, SANS, esc, aed, int, longDay } from './daily_report.js';

const SRC = 'cash-email';
const PLATFORM = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel' };
const ORDER = ['uber', 'bolt', 'yango', 'hotel'];
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const platformName = (p) => PLATFORM[p] || p;
const byOrder = (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || String(a).localeCompare(String(b));
const round2 = (v) => Math.round(Number(v) * 100) / 100;

/* The last try: 09:15 Dubai the morning after the cash day, a quarter hour
   after the cash run's own 09:00 final. */
export const lastCall = (day) => new Date(dubaiStart(addDays(day, 1)).getTime() + (9 * 60 + 15) * 60_000);

/** +971 50 123 4567 from the stored 971501234567; anything else as stored. */
export const readablePhone = (p) => {
  const s = String(p || '');
  const m = s.match(/^971(5\d)(\d{3})(\d{4})$/);
  return m ? `+971 ${m[1]} ${m[2]} ${m[3]}` : s;
};

/* Why a channel's cash is not in the amount, in the words the text's own
   record uses (driver_sms.js LEFT_OUT). */
const LEFT_OUT_WHY = {
  not_collected: 'that platform had not delivered the day when the text went',
  not_priced: 'no amount yet',
  hotel_by_name: 'hotel account keyed by a name',
};

/** The addresses, from the setting (the Settings page, else the
    environment — never the repository). */
export const cashRecipients = (raw = get('CASH_REPORT_RECIPIENTS', '')) =>
  [...new Set(String(raw || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)))];

/** Everything the email says about one cash day, read from the texts. */
export async function cashEmailFacts(q, day) {
  const [run] = await q(
    `SELECT status, hold_reason, detail FROM sms_outbox WHERE dedupe_key = $1`, [`cash-run:${day}`]);
  const rows = await q(
    `SELECT m.person_id, d.full_name, m.destination, m.detail, m.sent_at, m.provider_status
       FROM sms_outbox m LEFT JOIN driver d ON d.id = m.person_id
      WHERE m.kind = 'cash_deposit' AND m.business_day = $1::date AND m.status = 'sent'
      ORDER BY (m.detail->>'amount')::numeric DESC NULLS LAST, d.full_name, m.id`, [day]);
  const others = await q(
    `SELECT status, hold_reason, count(*)::int AS n FROM sms_outbox
      WHERE kind = 'cash_deposit' AND business_day = $1::date AND status <> 'sent'
      GROUP BY 1, 2 ORDER BY 3 DESC, 2`, [day]);
  const totals = new Map();
  const drivers = rows.map((r) => {
    const d = r.detail || {};
    const amount = d.amount == null ? null : round2(d.amount);
    const named = [...(d.channels || [])].sort(byOrder);
    /* The split as kept; a single named platform is the whole amount; two
       or more with no split kept are named with no amount each. */
    let split = null;
    if (Array.isArray(d.by_channel) && d.by_channel.length) {
      split = d.by_channel.map((c) => ({ platform: c.platform, amount: round2(c.amount), trips: c.trips ?? null,
        fleets: c.fleets || [] })).sort((a, b) => byOrder(a.platform, b.platform));
    } else if (named.length === 1 && amount != null) {
      split = [{ platform: named[0], amount, trips: null, fleets: [] }];
    }
    for (const c of split || []) totals.set(c.platform, round2((totals.get(c.platform) || 0) + c.amount));
    const leftOut = (d.left_out || []).filter((x) => x.trips > 0).map((x) => ({
      platform: x.platform, trips: x.trips, known_aed: x.known_aed ? round2(x.known_aed) : null, why: x.why }));
    const dlr = r.provider_status == null ? null : String(r.provider_status);
    return {
      name: r.full_name || null, person_id: r.person_id == null ? null : Number(r.person_id),
      phone: r.destination, amount, platforms: split ? split.map((c) => c.platform) : named, split,
      left_out: leftOut, sent_at: r.sent_at,
      delivery: dlr == null ? 'not_reported' : (/^deliver/i.test(dlr) ? 'delivered' : dlr),
    };
  });
  const unsplit = drivers.filter((x) => !x.split).length;
  return {
    day,
    run: run ? { status: run.status, reason: run.hold_reason, finished: run.detail?.finished === true,
      missing_catchup: run.detail?.missing_catchup || [], without_figure: run.detail?.uber_cash_trips_without_figure ?? null } : null,
    drivers,
    total: drivers.length ? round2(drivers.reduce((s, x) => s + (x.amount || 0), 0)) : 0,
    by_platform: [...totals.entries()].sort((a, b) => byOrder(a[0], b[0])).map(([platform, amount]) => ({ platform, amount })),
    unsplit,
    not_texted: others.map((o) => ({ status: o.status, reason: o.hold_reason, n: o.n })),
  };
}

/* Why the list is empty or may be short, in one sentence, or null. */
export function runNote(f) {
  const r = f.run;
  if (!r) {
    return 'The cash text run did not record finishing for this day — between 05:00 and 09:00 it either did not run or '
      + 'stopped part-way (the collector log says which)'
      + `${f.drivers?.length ? ', so this list is only the drivers it had texted before it stopped.' : ', and nobody was texted.'}`;
  }
  if (r.reason === 'switched_off') return 'The 05:00 cash text is switched off on the Access page, so nobody was texted for this day.';
  if (!r.finished) {
    return 'The cash text run was still waiting for Uber’s figures for this day when this email went'
      + `${r.missing_catchup.length ? ` (Uber ${r.missing_catchup.map((x) => FLEET[x] || x).join(' and ')} had not caught up)` : ''}`
      + ', so the drivers it had not reached yet are not here.';
  }
  if (r.status === 'held' && (r.reason === 'not_complete' || r.reason === 'waiting')) {
    return 'Nobody was texted for this day: Uber’s figures for it were still not complete at 09:00'
      + `${r.missing_catchup.length ? ` (Uber ${r.missing_catchup.map((x) => FLEET[x] || x).join(' and ')} had not caught up)` : ''}`
      + `${r.without_figure ? `, and ${int(r.without_figure)} Uber cash trip${r.without_figure === 1 ? ' was' : 's were'} still without Uber’s own amount` : ''}.`;
  }
  return null;
}

const notTextedWords = (o) => {
  if (o.status === 'failed') return 'the SMS gateway refused the text';
  if (o.status === 'queued') return 'the text was still being sent';
  const w = HOLD_WHY[o.reason];
  return w ? w.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) : (o.reason || 'held');
};

export function renderCashEmail(f, { dashboard = null } = {}) {
  const wd = new Date(`${f.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const note = runNote(f);
  const nNot = f.not_texted.reduce((s, o) => s + o.n, 0);
  const money = (v) => `<span style="font:400 13px ${SANS};color:${T.grey};letter-spacing:.04em">AED</span>&nbsp;${aed(v)}`;
  const deliveryWords = (x) => (x.delivery === 'delivered' ? null
    : x.delivery === 'not_reported' ? 'The gateway has not reported delivery yet.'
      : `The gateway reported it “${x.delivery}” — it may not have reached the driver.`);
  const splitCell = (x) => {
    if (x.split) return x.split.map((c) => `${esc(platformName(c.platform))}&nbsp;&nbsp;<span class="n">${aed(c.amount)}</span>`).join('<br>');
    return `${esc(x.platforms.map(platformName).join(', '))}<br><span class="n">split not recorded for this text</span>`;
  };
  const rowsHtml = f.drivers.map((x, i) => {
    const notes = [
      ...x.left_out.map((l) => `Not in this amount: ${platformName(l.platform)}, ${l.trips} cash trip${l.trips === 1 ? '' : 's'}`
        + `${l.known_aed ? ` (AED ${aed(l.known_aed)} known)` : ''} — ${LEFT_OUT_WHY[l.why] || l.why}`),
      deliveryWords(x),
    ].filter(Boolean);
    return `<tr>
      <td class="td" valign="top"><span class="n">${i + 1}</span>&nbsp;&nbsp;<b>${esc(x.name || `Driver #${x.person_id}`)}</b><br>
        <a href="tel:+${esc(x.phone)}" style="color:${T.ink2};text-decoration:none;white-space:nowrap">${esc(readablePhone(x.phone))}</a>
        ${notes.length ? `<div class="note">${notes.map(esc).join('<br>')}</div>` : ''}</td>
      <td class="td gap" valign="top">${splitCell(x)}</td>
      <td class="td r b" valign="top" align="right">${x.amount == null ? '—' : aed(x.amount)}</td>
    </tr>`;
  }).join('');
  const platformLine = f.by_platform.map((p) => `${platformName(p.platform)} AED ${aed(p.amount)}`).join(' · ');
  const warning = note ? `
    <tr><td style="padding:0 0 20px 0">
      <div style="font:400 14px/1.55 ${SANS};color:${T.ink};border-left:2px solid ${T.neg};padding:2px 0 2px 12px">${esc(note)}</div>
    </td></tr>` : '';
  const lead = f.drivers.length
    ? `${int(f.drivers.length)} driver${f.drivers.length === 1 ? ' was' : 's were'} texted this morning to deposit the cash they took on ${esc(wd)} — AED ${esc(aed(f.total))} in all.`
    : `Nobody was texted to deposit cash taken on ${esc(wd)}.`;
  const foot = nNot ? `${int(nNot)} more driver${nNot === 1 ? '' : 's'} took cash on ${wd} and ${nNot === 1 ? 'was' : 'were'} not texted: `
    + `${f.not_texted.map((o) => `${o.n} — ${notTextedWords(o)}`).join('; ')}.` : null;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>Cash to deposit — ${esc(longDay(f.day))}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Karla:wght@400;500;600&display=swap" rel="stylesheet">
<style>
.th{font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey};padding:0 0 8px 0;border-bottom:1px solid ${T.ink}}
.td{font:400 14px/1.5 ${SANS};color:${T.ink};padding:10px 0;border-bottom:1px solid ${T.hair};font-variant-numeric:tabular-nums}
.r{padding-left:12px;white-space:nowrap}.b{font-weight:600}.n{color:${T.grey}}.gap{padding-left:16px}
.note{font:400 12px/1.5 ${SANS};color:${T.grey};padding-top:4px}
@media (max-width:480px){.pad{padding-left:18px!important;padding-right:18px!important}}
</style></head>
<body style="margin:0;padding:0;background:${T.paper2}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.paper2}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${T.paper}">
<tr><td class="pad" style="padding:36px 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font:500 11px/1.4 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${T.grey};padding-bottom:10px">Ecosine &amp; Egari · cash to deposit</td></tr>
    <tr><td style="font:400 34px/1.15 ${SERIF};color:${T.ink};padding-bottom:20px">${esc(longDay(f.day))}</td></tr>
    ${warning}
    <tr><td style="padding:0 0 8px 0;font:400 17px/1.6 ${SERIF};color:${T.ink2}">${lead}</td></tr>
    ${platformLine ? `<tr><td style="padding:0 0 20px 0;font:400 13px/1.5 ${SANS};color:${T.grey}">${esc(platformLine)}${f.unsplit ? ` · ${int(f.unsplit)} driver${f.unsplit === 1 ? '' : 's'} on two platforms with no split recorded` : ''}</td></tr>` : ''}
  </table>
</td></tr>
${f.drivers.length ? `<tr><td class="pad" style="padding:8px 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><th align="left" class="th">Driver · mobile</th><th align="left" class="th gap">From</th><th align="right" class="th r">To deposit AED</th></tr>
    ${rowsHtml}
    <tr><td class="td b">Total</td><td class="td gap"></td><td class="td r b" align="right">${money(f.total)}</td></tr>
  </table>
</td></tr>` : ''}
<tr><td class="pad" style="padding:24px 36px 36px 36px;font:400 12px/1.6 ${SANS};color:${T.grey}">
  ${foot ? `${esc(foot)}<br><br>` : ''}
  Each amount is the one in the driver’s text: Uber’s own cash-collected figure where Uber reports it, the fare on the other platforms, for the Dubai day ${esc(f.day)}.
  Cash on a platform the text did not name is not in it and is listed under the driver.
  ${dashboard ? `<br><a href="${esc(dashboard)}/#messages" style="color:${T.ink}">Every text, and every one held back, on the dashboard</a>` : ''}
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Ecosine & Egari — cash to deposit — ${longDay(f.day)}`, '',
    note, note ? '' : null,
    lead.replace(/&amp;/g, '&'),
    platformLine || null, '',
    ...f.drivers.map((x, i) => [
      `${i + 1}. ${x.name || `Driver #${x.person_id}`} — ${readablePhone(x.phone)} — AED ${x.amount == null ? '—' : aed(x.amount)}`,
      `   ${x.split ? x.split.map((c) => `${platformName(c.platform)} ${aed(c.amount)}`).join(', ') : `${x.platforms.map(platformName).join(', ')} (split not recorded)`}`,
      ...x.left_out.map((l) => `   Not in this amount: ${platformName(l.platform)}, ${l.trips} cash trip${l.trips === 1 ? '' : 's'} — ${LEFT_OUT_WHY[l.why] || l.why}`),
      deliveryWords(x) ? `   ${deliveryWords(x)}` : null,
    ].filter(Boolean).join('\n')),
    f.drivers.length ? `\nTotal: AED ${aed(f.total)}` : null,
    foot ? `\n${foot}` : null,
  ].filter((l) => l != null).join('\n');
  const dm = new Date(`${f.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const subject = f.drivers.length
    ? `Cash to deposit — ${dm} · ${int(f.drivers.length)} driver${f.drivers.length === 1 ? '' : 's'} · AED ${aed(f.total)}`
    : `Cash to deposit — ${dm} · nobody texted`;
  return { html, text, subject };
}

/** The morning run: called every quarter hour from 08:00 to 09:45 Dubai.
    Sends the day's list to each address not yet sent it, once the cash text
    run has finished — or at 09:15 whatever the state, saying so. `only` (by
    hand) sends to one address now; `force` sends it again. */
export async function cashEmailRun({ q, now = new Date(), http = realHttp, day = yesterdayDubai(now),
  only = null, force = false, dashboard = get('PUBLIC_URL', '') || null } = {}) {
  const list = only ? cashRecipients(only) : cashRecipients();
  if (!list.length) return { day, due: 0, why: only ? 'not an email address' : 'CASH_REPORT_RECIPIENTS is empty' };
  const sent = new Set((await q(
    `SELECT recipient FROM cash_email_send WHERE business_day = $1::date AND status = 'sent'`, [day])).map((r) => r.recipient));
  const due = only && force ? list : list.filter((e) => !sent.has(e));
  if (!due.length) return { day, due: 0, sent: 0, failed: 0 };
  const facts = await cashEmailFacts(q, day);
  if (!only && !facts.run?.finished && now < lastCall(day)) return { day, due: due.length, waiting: true };
  const key = get('RESEND_API_KEY', '');
  const from = get('REPORT_FROM', 'Ecosine Fleet <reports@ecosine.ae>');
  const { html, text, subject } = renderCashEmail(facts, { dashboard });
  const summary = { drivers: facts.drivers.length, total: facts.total, finished: facts.run?.finished === true };
  let ok = 0, bad = 0;
  for (const to of due) {
    const idem = `cash-email/${day}/${to}${force ? `/manual-${now.getTime()}` : ''}`;
    const r = key
      ? await resendSend({ http, key, from, to, subject, html, text, idem })
        .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }))
      : { ok: false, error: 'RESEND_API_KEY is not set for the collector' };
    await q(`INSERT INTO cash_email_send (business_day, recipient, status, provider_id, error, detail)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (business_day, recipient) DO UPDATE SET status = EXCLUDED.status,
               provider_id = EXCLUDED.provider_id, error = EXCLUDED.error, detail = EXCLUDED.detail,
               attempts = cash_email_send.attempts + 1, updated_at = now()`,
    [day, to, r.ok ? 'sent' : 'failed', r.id || null, r.ok ? null : r.error, JSON.stringify(summary)]);
    r.ok ? ok++ : bad++;
  }
  /* Counts only: never a name, a number or an amount per driver. */
  log[bad ? 'warn' : 'info'](SRC, 'cash email', { day, sent: ok, failed: bad, drivers: facts.drivers.length,
    run_finished: facts.run?.finished === true });
  return { day, due: due.length, sent: ok, failed: bad, drivers: facts.drivers.length };
}
