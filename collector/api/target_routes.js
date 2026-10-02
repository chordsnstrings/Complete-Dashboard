/* The monthly revenue target, read; and the Today workbook.
   ═════════════════════════════════════════════════════════════════════════
     GET /api/target              the month as the Today page shows it
         ?month=YYYY-MM           another month (default: the Dubai month of today)
         ?asof=YYYY-MM-DD         computed as if today were this day, from the
                                  data held now (a past month's last morning)
     GET /api/target/hours        today's target hour by hour, revenue and
                                  trips, each against the usual day — the
                                  first page's two hourly panels
                                  (api/target_hours.js)
     GET /api/export/today.xlsx   the Today page as a workbook

   The arithmetic and every rule behind it live in api/revenue_target.js and
   api/today_workbook.js. Setting a target is the Owner's, re-confirmed, at
   POST /api/access/target (api/access/routes.js).

   NEVER CACHED (api/cache.js NEVER): the answer moves when the Owner saves a
   target or changes the trips a day, and the response cache's version only
   moves on a collection run or a rollup — so a save would be answered with
   the page from before it, the failure /api/same-person is listed there for. */
import { monthTarget, validMonth, validDay } from './revenue_target.js';
import { buildTodayWorkbook, TODAY_FILE_CLASSES } from './today_workbook.js';
import { targetHours } from './target_hours.js';

export const HOURS_KEEP_MS = 30000;

export function targetRoutes(app, { q, wrap, log = null }) {
  app.get('/api/target', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const month = validMonth(req.query.month) ? String(req.query.month) : null;
    const asof = validDay(req.query.asof) ? String(req.query.asof) : null;
    const out = await monthTarget(q, { month, today: asof });
    /* Who saved it is the admin panel's to show (GET /api/access/target); a
       staff member's email is not part of a figure. A seed says it is one. */
    out.saves = out.saves.map(({ set_by: _by, set_by_label: label, ...s }) => ({ ...s, seeded: label === 'system:seed' }));
    return res.json(out);
  }));

  /* The first page asks every minute from every screen that has it open, and
     one answer is the month's arithmetic, 28 days of hourly history and the
     live strip's whole day. So the answer is kept for HOURS_KEEP_MS: every
     screen inside that window gets the same figures (which is the point of the
     page), the database does the work once, and a target saved on the Access
     page is on it within the half-minute. The access layer shapes each
     reader's copy after this handler, so one stored answer serves every role. */
  let kept = { at: 0, val: null };
  app.get('/api/target/hours', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!kept.val || Date.now() - kept.at > HOURS_KEEP_MS) kept = { at: Date.now(), val: await targetHours(q) };
    return res.json(structuredClone(kept.val));
  }));

  app.get('/api/export/today.xlsx', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const levels = req.fm?.kind === 'user' || req.fm?.kind === 'device' ? (req.fm.levels || {}) : null;
    const hide = new Set(levels ? TODAY_FILE_CLASSES.filter((c) => levels[c] !== 'F') : []);
    const t0 = Date.now();
    const { wb, name, month, drivers, cars, findings } = await buildTodayWorkbook({ q, hide });
    const buf = wb.toBuffer();
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('content-length', String(buf.length));
    res.setHeader('x-export-month', month);
    if (hide.size) res.setHeader('x-export-withheld', [...hide].join(','));
    log?.info?.('api', 'today workbook', { month, drivers, cars, findings, bytes: buf.length, ms: Date.now() - t0 });
    return res.end(buf);
  }));
}
