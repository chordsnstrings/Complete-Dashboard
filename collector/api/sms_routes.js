/* THE MESSAGES PAGE'S TWO ANSWERS — what was texted, and what would be.
   ═════════════════════════════════════════════════════════════════════════
   GET /api/sms/log      every message the product decided about (sms_outbox):
                         sent, waiting for 07:00, failed at the gateway, or held
                         back — with the reason in words. The answer to "why did
                         this driver get nothing?".
   GET /api/sms/preview  what the next cash run and trip run WOULD decide, now,
                         without writing or sending anything.

   Both carry drivers' mobile numbers (class CT) and what was said to them — an
   amount of cash, a route (declared in api/access/manifest.json, so the shaper
   masks or withholds them by role). Neither answers someone who is not signed
   in, whatever the sign-in mode: while sign-in is optional the product's other
   pages still show everything to anyone, and this list would add every
   driver's number beside the words texted to them. */
import { HOLD_WHY, cashDepositRun, tripRegisterRun } from '../src/driver_sms.js';

export function smsRoutes(app, { q, wrap, access }) {
  const signedIn = (req, res) => {
    if (req.fm?.kind === 'user' && req.fm.user) return true;
    res.set('Cache-Control', 'no-store');
    res.status(401).json({ error: 'signin',
      detail: 'Sign in to see the messages: they carry drivers’ mobile numbers and what was texted to them.' });
    return false;
  };

  app.get('/api/sms/log', wrap(async (req, res) => {
    if (!signedIn(req, res)) return undefined;
    res.set('Cache-Control', 'private, no-store');
    const kind = ['cash_deposit', 'trip_register', 'reset_code', 'phone_code', 'cash_run'].includes(String(req.query.kind))
      ? String(req.query.kind) : null;
    const status = ['sent', 'queued', 'held', 'failed'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const rows = await q(
      `SELECT m.id, m.kind, m.status, m.hold_reason, m.person_id, d.full_name AS person_name,
              m.user_id, u.email AS user_email, m.fleet_id, m.destination, m.sender, m.message_text,
              m.not_before, m.provider_status, m.cost, m.error, m.plate, m.trip_start, m.trip_end,
              to_char(m.business_day, 'YYYY-MM-DD') AS business_day, m.detail, m.created_at, m.sent_at
         FROM sms_outbox m
         LEFT JOIN driver d ON d.id = m.person_id
         LEFT JOIN access_user u ON u.id = m.user_id
        WHERE ($1::text IS NULL OR m.kind = $1) AND ($2::text IS NULL OR m.status = $2)
        ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`, [kind, status]);
    const [counts] = await q(
      `SELECT count(*) FILTER (WHERE status = 'sent' AND kind IN ('cash_deposit', 'trip_register'))::int AS sent,
              count(*) FILTER (WHERE status = 'held' AND kind IN ('cash_deposit', 'trip_register'))::int AS held,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'failed' AND coalesce(error, '') <> 'sending')::int AS failed,
              coalesce(sum(cost) FILTER (WHERE status = 'sent'), 0)::float AS cost
         FROM sms_outbox WHERE created_at > now() - interval '7 days'`);
    const cfg = await access.getConfig();
    res.json({
      rows: rows.map((r) => ({ ...r, id: Number(r.id), person_id: r.person_id == null ? null : Number(r.person_id),
        user_id: r.user_id == null ? null : Number(r.user_id), why: r.hold_reason ? HOLD_WHY[r.hold_reason] || r.hold_reason : null })),
      last7days: counts,
      switches: { sms_cash: cfg.sms_cash, sms_trip: cfg.sms_trip },
      hold_why: HOLD_WHY,
    });
  }));

  app.get('/api/sms/preview', wrap(async (req, res) => {
    if (!signedIn(req, res)) return undefined;
    res.set('Cache-Control', 'private, no-store');
    const kind = String(req.query.kind) === 'trip' ? 'trip' : 'cash';
    const cfg = await access.getConfig();
    const t0 = Date.now();
    const r = kind === 'cash'
      ? await cashDepositRun({ q, cfg, dry: true })
      : await tripRegisterRun({ q, cfg, dry: true });
    /* The name beside each person, so the preview reads like the log. */
    const ids = [...new Set((r.decisions || []).map((d) => d.person).filter(Boolean).map(String))];
    const names = new Map(ids.length ? (await q(
      `SELECT id::text AS id, full_name FROM driver WHERE id::text = ANY($1::text[])`, [ids])).map((x) => [x.id, x.full_name]) : []);
    const decisions = (r.decisions || []).map((d) => ({ ...d, name: d.person ? names.get(String(d.person)) || null : null,
      why: d.hold ? HOLD_WHY[d.hold] || d.hold : null }));
    res.json({ kind, ...r, decisions, took_ms: Date.now() - t0,
      note: 'A dry run: decided now, nothing written, nothing sent. The real run can differ by the time it is due.' });
  }));
}
