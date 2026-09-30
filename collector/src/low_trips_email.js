/* THE 08:00 LOW-TRIPS EMAIL — active drivers under the day's minimum.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-09-30: "email [four addresses] any active driver who
   didn't have minimum 10 trips yesterday at 8 am Dubai time. This number of
   trips will change so we should be able to set it up in admin panel as
   well." And, asked what each word means:
     · ACTIVE — at least one completed trip, on any platform, in the eight
       Dubai days up to and including yesterday ("drove in the last 7 days");
     · A TRIP — a completed booking (trip_ext outcome 'completed') on Uber,
       Bolt, Yango or the hotel channel. A telematics journey is not a trip.
   The minimum is `low_trips_min` in the Access page's company settings
   (api/access/service.js DEFAULTS, 10), which the Owner changes without a
   deploy; the email reads it when it runs and prints it.

   ONE PERSON, ONE ROW. Grouped by api/custody_sql.js personKey() over
   trip_ext, exactly as the #day page and the 07:00 report group drivers, so a
   driver on Uber and Bolt is one row whose trips are summed, and the count
   here is the count there.

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON. A platform that
   had not delivered yesterday when the email went (daily_report.js
   channelsCollected, the 07:00 report's own test) may be holding trips this
   count does not have: it is named at the top, and every driver who worked
   that platform in the window is marked, because "4 trips" there may be a
   short count rather than a short day. */
import { http as realHttp } from './http.js';
import { get } from './settings.js';
import { log } from './log.js';
import { personKey } from '../api/custody_sql.js';
import { yesterdayDubai, resendSend, channelsCollected, EMAIL, T, SERIF, SANS, esc, int, longDay } from './daily_report.js';

const SRC = 'low-trips';
const PLATFORM = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel' };
const ORDER = ['uber', 'bolt', 'yango', 'hotel'];
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const platformName = (p) => PLATFORM[p] || p;
const byOrder = (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || String(a).localeCompare(String(b));
/* The window "active" is read over: yesterday and the seven days before. */
export const ACTIVE_DAYS = 8;
export const DEFAULT_MIN = 10;

/** The minimum from the Access page's settings, or the default when it is
    missing or not a whole number of at least 1. */
export const minTrips = (cfg) => {
  const n = Number(cfg?.low_trips_min);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MIN;
};

/** The addresses, from the setting (the Settings page, else the
    environment — never the repository). */
export const lowTripsRecipients = (raw = get('LOW_TRIPS_RECIPIENTS', '')) =>
  [...new Set(String(raw || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)))];

/** Every active driver's completed trips yesterday and over the seven days
    before, and which of them fell short of `min`. */
export async function lowTripsFacts(q, day, { min = DEFAULT_MIN } = {}) {
  const pk = personKey();
  const people = await q(
    `SELECT ${pk} AS pk,
            coalesce(mode() WITHIN GROUP (ORDER BY driver_name), '(unnamed)') AS name,
            mode() WITHIN GROUP (ORDER BY fleet_id) AS fleet,
            count(*) FILTER (WHERE local_day = $1::date)::int AS yday,
            count(*) FILTER (WHERE local_day < $1::date)::int AS before,
            count(DISTINCT local_day) FILTER (WHERE local_day < $1::date)::int AS before_days,
            to_char(max(local_day), 'YYYY-MM-DD') AS last_day,
            array_agg(DISTINCT platform || ':' || coalesce(fleet_id, '')) AS worked
       FROM trip_ext
      WHERE local_day BETWEEN $1::date - ${ACTIVE_DAYS - 1} AND $1::date
        AND is_booking AND outcome = 'completed' AND driver_name IS NOT NULL
      GROUP BY 1`, [day]);
  const split = await q(
    `SELECT ${pk} AS pk, platform, count(*)::int AS n
       FROM trip_ext
      WHERE local_day = $1::date AND is_booking AND outcome = 'completed' AND driver_name IS NOT NULL
      GROUP BY 1, 2`, [day]);
  const splitBy = new Map();
  for (const s of split) {
    if (!splitBy.has(s.pk)) splitBy.set(s.pk, []);
    splitBy.get(s.pk).push({ platform: s.platform, trips: s.n });
  }
  const collection = await channelsCollected(q, day);
  const missing = new Set(collection.missing.map((m) => `${m.platform}:${m.fleet}`));
  const below = people.filter((p) => p.yday < min).map((p) => {
    const worked = (p.worked || []).filter(Boolean);
    const gaps = worked.filter((w) => missing.has(w)).map((w) => {
      const [platform, fleet] = w.split(':');
      return { platform, fleet };
    });
    return {
      name: p.name, fleet: p.fleet || null, yesterday: p.yday,
      by_platform: (splitBy.get(p.pk) || []).sort((a, b) => byOrder(a.platform, b.platform)),
      before: p.before, before_days: p.before_days, last_day: p.last_day,
      platforms: [...new Set(worked.map((w) => w.split(':')[0]))].sort(byOrder),
      maybe_short: gaps,
    };
  }).sort((a, b) => a.yesterday - b.yesterday || b.before - a.before || a.name.localeCompare(b.name));
  return {
    day, min, active: people.length, below, at_or_above: people.length - below.length,
    did_not_drive: below.filter((x) => x.yesterday === 0).length,
    collection,
  };
}

export function renderLowTripsEmail(f, { dashboard = null } = {}) {
  const wd = new Date(`${f.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const gapWords = (g) => g.map((m) => `${platformName(m.platform)} · ${FLEET[m.fleet] || m.fleet}`).join(', ');
  const missing = f.collection.missing;
  const warning = missing.length ? `
    <tr><td style="padding:0 0 20px 0">
      <div style="font:400 14px/1.55 ${SANS};color:${T.ink};border-left:2px solid ${T.neg};padding:2px 0 2px 12px">
        ${esc(gapWords(missing))} had not delivered ${esc(wd)}’s trips when this was sent, so a driver who works there may have more trips than shown. Each one is marked.
      </div></td></tr>` : '';
  const lead = f.below.length
    ? `${int(f.below.length)} of ${int(f.active)} active drivers completed fewer than ${int(f.min)} trips on ${esc(wd)}`
      + `${f.did_not_drive ? ` — ${int(f.did_not_drive)} of them none at all` : ''}.`
    : (f.active ? `Every one of the ${int(f.active)} active drivers completed at least ${int(f.min)} trips on ${esc(wd)}.`
      : `No driver completed a trip in the ${ACTIVE_DAYS} days to ${esc(wd)}, so there is nobody to list.`);
  const usual = (x) => (x.before_days ? `${int(x.before)} on ${int(x.before_days)} day${x.before_days === 1 ? '' : 's'}`
    + `<br><span class="n">${(x.before / x.before_days).toFixed(1)} a day</span>` : '<span class="n">did not drive</span>');
  const rows = f.below.map((x) => {
    const notes = [
      x.yesterday === 0 ? `Did not drive ${wd}; last trip ${x.last_day}.` : null,
      x.maybe_short.length ? `${gapWords(x.maybe_short)} had not delivered — the count may be short.` : null,
    ].filter(Boolean);
    return `<tr>
      <td class="td" valign="top"><b>${esc(x.name)}</b>${x.fleet ? `<br><span class="n">${esc(FLEET[x.fleet] || x.fleet)} · ${esc(x.platforms.map(platformName).join(', '))}</span>` : ''}
        ${notes.length ? `<div class="note">${notes.map(esc).join('<br>')}</div>` : ''}</td>
      <td class="td r" valign="top" align="right"><b class="big">${int(x.yesterday)}</b>${x.by_platform.length > 1 ? `<br><span class="n">${esc(x.by_platform.map((c) => `${platformName(c.platform)} ${c.trips}`).join(' · '))}</span>` : ''}</td>
      <td class="td r" valign="top" align="right">${usual(x)}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>Under ${esc(f.min)} trips — ${esc(longDay(f.day))}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Karla:wght@400;500;600&display=swap" rel="stylesheet">
<style>
.th{font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey};padding:0 0 8px 0;border-bottom:1px solid ${T.ink}}
.td{font:400 14px/1.5 ${SANS};color:${T.ink};padding:10px 0;border-bottom:1px solid ${T.hair};font-variant-numeric:tabular-nums}
.r{padding-left:12px;white-space:nowrap}.n{color:${T.grey};font-size:12px}.big{font:400 20px/1.2 ${SERIF}}
.note{font:400 12px/1.5 ${SANS};color:${T.grey};padding-top:4px}
@media (max-width:480px){.pad{padding-left:18px!important;padding-right:18px!important}}
</style></head>
<body style="margin:0;padding:0;background:${T.paper2}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.paper2}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${T.paper}">
<tr><td class="pad" style="padding:36px 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font:500 11px/1.4 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${T.grey};padding-bottom:10px">Ecosine &amp; Egari · under ${esc(f.min)} trips</td></tr>
    <tr><td style="font:400 34px/1.15 ${SERIF};color:${T.ink};padding-bottom:20px">${esc(longDay(f.day))}</td></tr>
    ${warning}
    <tr><td style="padding:0 0 20px 0;font:400 17px/1.6 ${SERIF};color:${T.ink2}">${lead}</td></tr>
  </table>
</td></tr>
${f.below.length ? `<tr><td class="pad" style="padding:0 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><th align="left" class="th">Driver</th><th align="right" class="th r">${esc(wd.slice(0, 3))}</th><th align="right" class="th r">7 days before</th></tr>
    ${rows}
  </table>
</td></tr>` : ''}
<tr><td class="pad" style="padding:24px 36px 36px 36px;font:400 12px/1.6 ${SANS};color:${T.grey}">
  A trip is a completed booking on Uber, Bolt, Yango or the hotel channel, in the Dubai day ${esc(f.day)}; a driver on two platforms is one row.
  Active means at least one completed trip in the ${ACTIVE_DAYS} days to ${esc(wd)}. ${int(f.at_or_above)} active driver${f.at_or_above === 1 ? '' : 's'} reached ${int(f.min)} or more.
  The minimum, ${int(f.min)}, is set by the Owner on the Access page.
  ${dashboard ? `<br><a href="${esc(dashboard)}/#day/${esc(f.day)}" style="color:${T.ink}">Open this day on the dashboard</a>` : ''}
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Ecosine & Egari — under ${f.min} trips — ${longDay(f.day)}`, '',
    missing.length ? `${gapWords(missing)} had not delivered ${wd}'s trips when this was sent; drivers who work there are marked.` : null,
    missing.length ? '' : null,
    lead.replace(/&amp;/g, '&'), '',
    ...f.below.map((x) => [
      `${x.name}${x.fleet ? ` (${FLEET[x.fleet] || x.fleet})` : ''} — ${x.yesterday} trip${x.yesterday === 1 ? '' : 's'}`
        + `${x.by_platform.length > 1 ? ` (${x.by_platform.map((c) => `${platformName(c.platform)} ${c.trips}`).join(', ')})` : ''}`
        + ` — 7 days before: ${x.before_days ? `${x.before} on ${x.before_days} days` : 'did not drive'}`,
      x.yesterday === 0 ? `   Did not drive ${wd}; last trip ${x.last_day}.` : null,
      x.maybe_short.length ? `   ${gapWords(x.maybe_short)} had not delivered — the count may be short.` : null,
    ].filter(Boolean).join('\n')),
    '', `Active: at least one completed trip in the ${ACTIVE_DAYS} days to ${wd}. ${f.at_or_above} reached ${f.min} or more. The minimum is set on the Access page.`,
  ].filter((l) => l != null).join('\n');
  const dm = new Date(`${f.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const subject = `Under ${f.min} trips — ${dm} · ${int(f.below.length)} of ${int(f.active)} active drivers`;
  return { html, text, subject };
}

/** The morning run: called every quarter hour from 08:00 to 09:45 Dubai, so
    a send that failed is retried; each address gets a day's list once. The
    list is composed once per day and kept, so a retry sends what 08:00 saw.
    `only` (by hand) sends to one address now; `force` sends it again. */
export async function lowTripsRun({ q, now = new Date(), http = realHttp, day = yesterdayDubai(now), cfg = {},
  only = null, force = false, dashboard = get('PUBLIC_URL', '') || null } = {}) {
  const list = only ? lowTripsRecipients(only) : lowTripsRecipients();
  if (!list.length) return { day, due: 0, why: only ? 'not an email address' : 'LOW_TRIPS_RECIPIENTS is empty' };
  const sent = new Set((await q(
    `SELECT recipient FROM low_trips_email_send WHERE business_day = $1::date AND status = 'sent'`, [day])).map((r) => r.recipient));
  const due = only && force ? list : list.filter((e) => !sent.has(e));
  if (!due.length) return { day, due: 0, sent: 0, failed: 0 };
  /* Composed once, at the first send of the day; a retry and a later
     recipient get the same list, not one recounted with the minimum changed
     half-way through the morning. A forced send by hand recomposes. */
  const [kept] = force ? [] : await q(
    `SELECT detail FROM low_trips_email_send WHERE business_day = $1::date AND detail ? 'facts' ORDER BY created_at LIMIT 1`, [day]);
  const facts = kept?.detail?.facts || await lowTripsFacts(q, day, { min: minTrips(cfg) });
  const key = get('RESEND_API_KEY', '');
  const from = get('REPORT_FROM', 'Ecosine Fleet <reports@ecosine.ae>');
  const { html, text, subject } = renderLowTripsEmail(facts, { dashboard });
  let ok = 0, bad = 0;
  for (const to of due) {
    const idem = `low-trips/${day}/${to}${force ? `/manual-${now.getTime()}` : ''}`;
    const r = key
      ? await resendSend({ http, key, from, to, subject, html, text, idem })
        .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }))
      : { ok: false, error: 'RESEND_API_KEY is not set for the collector' };
    await q(`INSERT INTO low_trips_email_send (business_day, recipient, status, provider_id, error, detail)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (business_day, recipient) DO UPDATE SET status = EXCLUDED.status,
               provider_id = EXCLUDED.provider_id, error = EXCLUDED.error, detail = EXCLUDED.detail,
               attempts = low_trips_email_send.attempts + 1, updated_at = now()`,
    [day, to, r.ok ? 'sent' : 'failed', r.id || null, r.ok ? null : r.error, JSON.stringify({ facts })]);
    r.ok ? ok++ : bad++;
  }
  /* Counts only: never a name. */
  log[bad ? 'warn' : 'info'](SRC, 'low trips email', { day, sent: ok, failed: bad, min: facts.min,
    active: facts.active, below: facts.below.length });
  return { day, due: due.length, sent: ok, failed: bad, min: facts.min, active: facts.active, below: facts.below.length };
}
