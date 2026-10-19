/* The Low performers page and its watch lists (api/lowperf.js).
   ═════════════════════════════════════════════════════════════════════════
     GET  /api/lowperf                    every driver below target over a period
          ?from=YYYY-MM-DD&to=YYYY-MM-DD   default: the month so far, to yesterday
          ?hotel=hide|mostly|show          default hide: hotel-only drivers left out
          ?fleet=ecosine|egari             default: both
          ?asof=YYYY-MM-DD                 computed as if today were this day, from
                                           the data held now (as /api/target/month)
     GET  /api/export/lowperf.xlsx        the same, as a workbook (same params)
     GET  /api/lowperf/watch              the saved watch lists
     POST /api/lowperf/watch              save one: { name, from, to, hotel, fleet, pks?, note? }
     GET  /api/lowperf/watch/:id          one list followed: its members day by day
          ?a=FROM[..TO]&b=FROM[..TO]       the two spans compared (default: the
                                           14 days before the save, and since)
          ?asof=YYYY-MM-DD                 as if today were this day
     POST /api/lowperf/watch/:id          change one: { name?, note?, add?: [pk], remove?: [pk], archive?: true }
     GET  /api/export/lowperf-watch.xlsx  ?id=&a=&b= — a list followed, as a workbook

   WHO KEEPS THE LISTS. The Owner and the Operations managers (the capability
   watchlist.edit, ruled 2026-10-19). The access layer checks the capability
   for a signed-in person; this file also refuses a visitor who is not signed
   in, which the access layer's open mode would otherwise let through — a
   watch list says who saved it, and "anyone with the link" is not the
   operator's ruling.

   A SAVED LIST IS THE SERVER'S. A save names a period and settings; the
   members and their figures at the save are computed here from that period,
   never taken from the page — a page could send any figure, and "where they
   started" is the figure every later day is read against. A save may narrow
   the list to some of its people (pks), never add someone the period does not
   hold.

   NEVER CACHED (api/cache.js NEVER): a list changes on a click and the target
   on the Owner's save, and neither moves the response cache's version. */
import {
  lowperfView, spansOf, loadWatch, watchOf, periodOf, loadLowperf, lowperfOf, loadExtras, HOTEL_MODES,
} from './lowperf.js';
import { lowperfWorkbookOf, watchWorkbookOf, LOWPERF_FILE_CLASSES } from './lowperf_workbook.js';
import { dubaiDay } from './window.js';
import { addDays, validDay } from './revenue_target.js';
import { loadDriverDays } from './target_month.js';

const FLEETS = ['ecosine', 'egari'];
const params = (req) => ({
  from: validDay(req.query.from) ? String(req.query.from) : null,
  to: validDay(req.query.to) ? String(req.query.to) : null,
  hotel: HOTEL_MODES.includes(String(req.query.hotel)) ? String(req.query.hotel) : 'hide',
  fleet: FLEETS.includes(String(req.query.fleet)) ? String(req.query.fleet) : null,
  today: validDay(req.query.asof) ? String(req.query.asof) : null,
});
const hideOf = (req) => {
  const levels = req.fm?.kind === 'user' || req.fm?.kind === 'device' ? (req.fm.levels || {}) : null;
  return new Set(levels ? LOWPERF_FILE_CLASSES.filter((c) => levels[c] !== 'F') : []);
};
const sendBook = (res, { wb, name }, hide) => {
  const buf = wb.toBuffer();
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="${name}"`);
  res.setHeader('content-length', String(buf.length));
  if (hide.size) res.setHeader('x-export-withheld', [...hide].join(','));
  return res.end(buf);
};

/** May this caller change watch lists? A signed-in person holding
    watchlist.edit; never a visitor, a screen or the system. */
export function editorOf(req) {
  const fm = req.fm;
  if (fm?.kind !== 'user') {
    return { status: 401, error: 'signin', detail: 'Sign in to keep a watch list — the Owner and the Operations managers keep them.' };
  }
  if (!(fm.access?.caps || []).includes('watchlist.edit')) {
    return { status: 403, error: 'not_allowed', detail: 'Only the Owner and the Operations managers keep watch lists.' };
  }
  return { by: fm.user?.id ?? null };
}

const listRow = (r) => ({
  id: Number(r.id), name: r.name, saved_day: r.saved_day, period_from: r.period_from, period_to: r.period_to,
  hotel: r.hotel, fleet: r.fleet, note: r.note, created_at: r.created_at, archived: !!r.archived_at,
  members: Number(r.members) || 0,
});
const LIST_SQL = `SELECT w.id, w.name, to_char(w.saved_day, 'YYYY-MM-DD') AS saved_day,
                         to_char(w.period_from, 'YYYY-MM-DD') AS period_from, to_char(w.period_to, 'YYYY-MM-DD') AS period_to,
                         w.hotel, w.fleet, w.note, w.created_at, w.archived_at,
                         (SELECT count(*) FROM lowperf_watch_member m WHERE m.watch_id = w.id AND m.removed_at IS NULL) AS members
                    FROM lowperf_watch w`;

export function lowperfRoutes(app, { q, wrap, log = null }) {
  app.get('/api/lowperf', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    return res.json(await lowperfView(q, params(req)));
  }));

  app.get('/api/export/lowperf.xlsx', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const hide = hideOf(req);
    const t0 = Date.now();
    const v = await lowperfView(q, params(req));
    const book = lowperfWorkbookOf(v, { hide });
    log?.info?.('api', 'low performers workbook', { from: v.from, to: v.to, rows: book.rows, ms: Date.now() - t0 });
    return sendBook(res, book, hide);
  }));

  app.get('/api/lowperf/watch', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const all = req.query.archived === '1';
    const rows = await q(`${LIST_SQL} ${all ? '' : 'WHERE w.archived_at IS NULL'} ORDER BY w.saved_day DESC, w.id DESC`);
    return res.json({ lists: rows.map(listRow) });
  }));

  app.post('/api/lowperf/watch', wrap(async (req, res) => {
    const who = editorOf(req);
    if (who.error) return res.status(who.status).json({ error: who.error, detail: who.detail });
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'name', detail: 'Give the list a name of up to 120 characters.' });
    const today = dubaiDay(new Date());
    const p = periodOf({ from: validDay(b.from) ? b.from : null, to: validDay(b.to) ? b.to : null, today });
    const hotel = HOTEL_MODES.includes(String(b.hotel)) ? String(b.hotel) : 'hide';
    const fleet = FLEETS.includes(String(b.fleet)) ? String(b.fleet) : null;
    const v = lowperfOf({ ...(await loadLowperf(q, { from: p.from, to: p.to, today })), hotel, fleet, notes: p.notes });
    const want = Array.isArray(b.pks) ? new Set(b.pks.map(String)) : null;
    const members = v.rows.filter((r) => !want || want.has(r.pk));
    if (!members.length) {
      return res.status(400).json({ error: 'empty', detail: want ? 'None of the people chosen is below target over that period.'
        : 'Nobody is below target over that period, so there is nobody to watch.' });
    }
    const [w] = await q(`INSERT INTO lowperf_watch (name, saved_day, period_from, period_to, hotel, fleet, note, created_by)
                         VALUES ($1, $2::date, $3::date, $4::date, $5, $6, $7, $8) RETURNING id`,
    [name, today, v.from, v.to, hotel, fleet, b.note ? String(b.note).slice(0, 500) : null, who.by]);
    for (const r of members) {
      await q(`INSERT INTO lowperf_watch_member (watch_id, pk, ids, name, fleet, at_save, added_by)
               VALUES ($1, $2, $3::text[], $4, $5, $6::jsonb, $7)`,
      [w.id, r.pk, r.ids || [], r.name, r.fleet, JSON.stringify({ gross: r.gross, target: r.gross_target, pct: r.gross_pct,
        band: r.band, days_active: r.days_active, days_driven: r.days_driven, from: v.from, to: v.to }), who.by]);
    }
    log?.info?.('api', 'watch list saved', { id: Number(w.id), members: members.length });
    const [row] = await q(`${LIST_SQL} WHERE w.id = $1`, [w.id]);
    return res.json({ ok: true, list: listRow(row) });
  }));

  const loadOne = async (id) => {
    if (!/^\d{1,12}$/.test(String(id))) return null;
    const [row] = await q(`${LIST_SQL} WHERE w.id = $1`, [Number(id)]);
    return row ? listRow(row) : null;
  };
  const follow = async (watch, req) => {
    const today = validDay(req.query.asof) ? String(req.query.asof) : dubaiDay(new Date());
    const sp = spansOf({ saved: watch.saved_day, today, a: req.query.a, b: req.query.b });
    const members = await q(`SELECT pk, ids, name, at_save FROM lowperf_watch_member
                              WHERE watch_id = $1 AND removed_at IS NULL ORDER BY pk`, [watch.id]);
    const bundle = await loadWatch(q, { saved: watch.saved_day, a: sp.a, b: sp.b, today });
    return { ...watchOf({ watch, members, a: sp.a, b: sp.b, ...bundle }), default_spans: sp.defaults };
  };

  app.get('/api/lowperf/watch/:id', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const watch = await loadOne(req.params.id);
    if (!watch) return res.status(404).json({ error: 'not_found', detail: 'No watch list has that number.' });
    return res.json(await follow(watch, req));
  }));

  app.get('/api/export/lowperf-watch.xlsx', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const watch = await loadOne(req.query.id);
    if (!watch) return res.status(404).json({ error: 'not_found', detail: 'No watch list has that number.' });
    const hide = hideOf(req);
    return sendBook(res, watchWorkbookOf(await follow(watch, req), { hide }), hide);
  }));

  app.post('/api/lowperf/watch/:id', wrap(async (req, res) => {
    const who = editorOf(req);
    if (who.error) return res.status(who.status).json({ error: who.error, detail: who.detail });
    const watch = await loadOne(req.params.id);
    if (!watch) return res.status(404).json({ error: 'not_found', detail: 'No watch list has that number.' });
    const b = req.body || {};
    if (b.name != null) {
      const name = String(b.name).trim();
      if (!name || name.length > 120) return res.status(400).json({ error: 'name', detail: 'Give the list a name of up to 120 characters.' });
      await q('UPDATE lowperf_watch SET name = $2 WHERE id = $1', [watch.id, name]);
    }
    if (b.note !== undefined) await q('UPDATE lowperf_watch SET note = $2 WHERE id = $1', [watch.id, b.note ? String(b.note).slice(0, 500) : null]);
    if (b.archive === true) await q('UPDATE lowperf_watch SET archived_at = now(), archived_by = $2 WHERE id = $1 AND archived_at IS NULL', [watch.id, who.by]);
    if (b.archive === false) await q('UPDATE lowperf_watch SET archived_at = NULL, archived_by = NULL WHERE id = $1', [watch.id]);
    const remove = Array.isArray(b.remove) ? b.remove.map(String).slice(0, 500) : [];
    if (remove.length) {
      await q(`UPDATE lowperf_watch_member SET removed_at = now(), removed_by = $3
                WHERE watch_id = $1 AND pk = ANY($2::text[]) AND removed_at IS NULL`, [watch.id, remove, who.by]);
    }
    /* Adding someone: they must have driven in the five weeks to yesterday —
       the person is looked up here, with every account they held, so a later
       merge still finds them. Their "at save" is left empty: they joined
       after the list was saved, and the page says so. */
    const add = Array.isArray(b.add) ? b.add.map(String).slice(0, 200) : [];
    const added = [];
    const unknown = [];
    if (add.length) {
      const today = dubaiDay(new Date());
      const to = addDays(today, -1);
      const from = addDays(to, -34);
      const [dd, extras] = await Promise.all([loadDriverDays(q, from, to), loadExtras(q, { hotelFrom: from, from, to })]);
      for (const pk of add) {
        const w = dd.who.get(pk);
        if (!w) { unknown.push(pk); continue; }
        await q(`INSERT INTO lowperf_watch_member (watch_id, pk, ids, name, fleet, added_by)
                 VALUES ($1, $2, $3::text[], $4, $5, $6)
                 ON CONFLICT (watch_id, pk) DO UPDATE SET removed_at = NULL, removed_by = NULL`,
        [watch.id, pk, extras.get(pk)?.ids || [], w.name, w.fleet, who.by]);
        added.push(pk);
      }
    }
    return res.json({ ok: true, list: await loadOne(watch.id), added: added.length, removed: remove.length,
      unknown: unknown.length ? `${unknown.length} of the people to add drove nothing in the five weeks to yesterday and were not added.` : null });
  }));
}
