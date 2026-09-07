/* Who a finding is about, as people rather than as a count.
   ═══════════════════════════════════════════════════════════════════════════
   Its own module rather than another six hundred lines of app.js, for the
   reason api/public/roster.js is its own module: a renderer that lives inside
   the router can only be tested by driving the whole application, and one that
   does not can be imported into a page and asked what it produced. */
import { el, esc, pill, entity, countOf, avatar, dateStr, timeStr } from './ui.js';
import { fmt } from './charts.js';
import { href } from './data.js';

/* Who a finding is about, as people rather than as a count.
   ═══════════════════════════════════════════════════════════════════════════
   "10 drivers were online but completed no trips" was the whole of it. The
   action beneath it — "check whether they were genuinely available, sitting in
   a dead zone, or logged in without intending to work" — cannot be carried out
   from a number, and the ids that would let somebody carry it out had been
   stored in insight.refs since sql/schema_v31.sql, served by /api/insights ever
   since, and read by nothing: `grep '\.refs' api/public/*.js` returned no hits
   at all on 2026-09-07.

   api/insight_people.js resolves those ids into a person. This draws them.

   A card rather than a table, because the question this page answers is "who do
   I ring", and the answer wants a face, a name and a number together rather
   than nine sortable columns. The facts under each name are ordered the way the
   call goes: when they were online, what they were holding, when they last
   actually worked, and what normal looks like for them — so the operator knows
   before dialling whether this is a bad morning or a dormant account.

   Every fact that is absent says why it is absent. A driver with no phone
   number on file and a driver whose phone number we have not collected are two
   different problems, and only one of them is fixed by ringing somebody. */
export const agoStr = (iso) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const h = (Date.now() - t) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${fmt(d)} days ago` : `${fmt(Math.round(d / 30))} months ago`;
};

/* A fact row, or nothing at all — never a row whose value is a dash.
   An empty value in a two-column list reads as "we looked and there is
   nothing", which is only sometimes true; where it IS the answer the caller
   passes the reason as the value and it renders in the muted style. */
export const whoFact = (label, value, { absent = false } = {}) => (value
  ? `<div class="wf-k">${esc(label)}</div>`
    + `<div class="wf-v${absent ? ' wf-absent' : ''}">${value}</div>`
  : '');

export function peopleCards(refs) {
  const grid = el('div', 'whocards');
  refs.forEach((p) => {
    const name = p.full_name || null;
    const card = el('article', 'whocard');
    /* The identity line. The name links to the driver page — this finding is
       one reading and that page is the rest of them — and falls back to the id
       when no channel has filed a name, because an unnamed person still has to
       be clickable to be investigated. */
    const title = name
      ? `<a class="ent" href="${href('driver', p.driver_ext_id)}">${esc(name)}</a>`
      : `<a class="ent" href="${href('driver', p.driver_ext_id)}">${esc(String(p.driver_ext_id).slice(0, 8))}…</a>`
        + ' <span class="dim">no channel has filed a name for this account</span>';
    /* tel: and mailto: are the point of the card. A number rendered as text is
       a number somebody retypes into a handset. */
    const contact = [
      p.phone ? `<a class="lnk" href="tel:${esc(String(p.phone).replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : '',
      p.email ? `<a class="lnk" href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '',
    ].filter(Boolean).join('<span class="dim"> · </span>');
    const stateTone = /suspend|deact|block|reject|ban/i.test(p.state_raw || p.state || '') ? 'bad'
      : /waitlist|onboard|pending|applied/i.test(p.state || '') ? 'warn' : 'ok';

    /* WHEN they went online, un-clipped. `began_before_window` is the whole
       reason this is not read from driver_day: those spans are cut at the Dubai
       midnight, so a shift opened at 23:43 reads 00:00, and "went online at
       midnight" starts the wrong conversation. */
    const onlineWhen = p.online_at
      ? `${timeStr(p.online_at)}${p.began_before_window
        ? ' <span class="dim">— the shift opened the evening before</span>' : ''}`
        + (p.online_ended_at
          ? ` <span class="dim">until ${timeStr(p.online_ended_at)}</span>`
          : ' <span class="dim">— still open, no log-off recorded</span>')
      : null;
    const hours = p.hours_online != null
      ? `${fmt(p.hours_online, 1)} h logged in` : null;

    /* WHERE from. Uber fills lat/lon on none of its 194,107 timeline rows
       (docs/COVERAGE.md), so this is almost always the absent branch — and it
       says which of the two absences it is rather than printing a dash. It is
       never inferred from their trips: they completed none, which is the
       finding. */
    const where = (p.online_lat != null && p.online_lon != null)
      ? `${p.online_lat.toFixed(4)}, ${p.online_lon.toFixed(4)}`
      : null;

    const lastTrip = p.last_trip_at
      ? `${dateStr(p.last_trip_at)} <span class="dim">${esc(agoStr(p.last_trip_at) || '')}</span>`
        + (p.last_trip_addr ? `<br><span class="dim">ended at ${esc(p.last_trip_addr)}</span>` : '')
      : null;

    const normal = p.trips_28d
      ? `${countOf(p.trips_28d, 'trip')} over ${countOf(p.days_28d, 'day')} in the last four weeks`
      : null;

    card.innerHTML = `
      <div class="whohead">
        ${avatar(name || String(p.driver_ext_id), p.picture_url, 'sm', p.photo_absent_reason)}
        <div class="whoid">
          <b>${title}</b>
          <div class="cap">${contact
            || '<span class="wf-absent">no phone number or email address on file for this account</span>'}</div>
        </div>
        ${p.state ? pill(p.state_raw || p.state, stateTone) : ''}
      </div>
      <div class="whofacts">
        ${whoFact('Online', [onlineWhen, hours].filter(Boolean).join('<br>')
          || 'no ONLINE event on this account for the window', { absent: !onlineWhen && !hours })}
        ${whoFact('Vehicle', p.state_plate
          ? entity('vehicle', p.state_plate, p.state_plate)
          : p.last_trip_plate
            ? `${entity('vehicle', p.last_trip_plate, p.last_trip_plate)}`
              + ' <span class="dim">— the car they last drove, not a current assignment</span>'
            : 'no vehicle is assigned to this account', { absent: !p.state_plate && !p.last_trip_plate })}
        ${whoFact('Went online from', where
          || 'this channel does not report a position with the log-in', { absent: !where })}
        ${whoFact('Last completed trip', lastTrip
          || 'no completed trip has ever been collected for this account', { absent: !lastTrip })}
        ${whoFact('Normally', normal
          || 'nothing completed in the last four weeks', { absent: !normal })}
        ${whoFact('Rating', p.platform_rating != null
          ? `${fmt(p.platform_rating, 2)}${p.lifetime_trips
            ? ` <span class="dim">over ${fmt(p.lifetime_trips)} lifetime trips</span>` : ''}`
          : null)}
      </div>`;
    grid.append(card);
  });
  return grid;
}

/* True when the API resolved the ids into people rather than handing back the
   bare refs the rule wrote. An unresolved ref is still worth showing — the id
   is a link to a page that knows everything — so this decides the CAPTION, not
   whether to render. */
export const peopleResolved = (refs) => refs.filter((p) => p && (p.full_name || p.phone
  || p.picture_url || p.online_at || p.last_trip_at)).length;


/* The first few names, on the list row itself.
   A finding that says "10 drivers" and links to a page that says who they are
   is better than one that says neither, but the list is what an operations lead
   scans first thing — and a name on it is what turns "10 drivers" from a
   statistic into a morning's work. Three names and a remainder: enough to
   recognise the shift, short enough not to wrap the card. */
export const namesLine = (r) => {
  const named = (Array.isArray(r.refs) ? r.refs : [])
    .map((p) => p && p.full_name).filter(Boolean);
  if (!named.length) return '';
  const shown = named.slice(0, 3).join(', ');
  return `<div class="insight-who">${esc(shown)}`
    + (named.length > 3 ? `<span class="dim"> and ${fmt(named.length - 3)} more</span>` : '')
    + '</div>';
};

