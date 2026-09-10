/* TESLA: the grant, and what it is worth.
   ──────────────────────────────────────────────────────────────────────────
   The fleet owns 82 Teslas — 72 Model Y and 10 Model 3 of 273 plates,
   measured on production 2026-09-10 through this very endpoint — and 78 of
   them carry a VIN, which is Tesla's own join key. So most of the cars are
   already identified; what is missing is permission to ask Tesla about them.

   The four Model Ys with no VIN are not a Tesla problem and will not be fixed
   by the grant: a car Tesla can answer about is a car we can NAME to Tesla,
   and a plate is not a name Tesla knows. They will render absent with that
   reason rather than silently dropping out of a count of 82.

   That permission has exactly one shape and only a human can grant it. The
   client id and secret in Settings authenticate this APPLICATION, and an
   application owns no cars: measured live, a partner token answers
   `GET /api/1/vehicles` with HTTP 200 and a count of zero. Reading the fleet
   needs a token minted from an authorization CODE, and Tesla only issues that
   after the person who owns the vehicles signs in and approves this app.

   These three routes are the whole of that handshake:

     /api/tesla/status   what we hold, what is missing, and what it is worth
     /api/tesla/connect  the link to hand to whoever owns the Tesla account
     /teslaredirect      where Tesla sends them back, carrying the code

   The last one is NOT under /api on purpose: it is the redirect URI already
   registered in Tesla's developer console, and Tesla will refuse any other. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { authorizeUrl, exchangeCode, accessToken, partnerToken, teslaBase, teslaRegion }
  from '../src/auth/tesla.js';
import { get, setSetting, loadSettings } from '../src/settings.js';

const REDIRECT = 'https://fleet-dashboard-wpeqb.ondigitalocean.app/teslaredirect';

/* The `state` parameter, held in memory rather than in the database.
   ──────────────────────────────────────────────────────────────────────────
   It exists so a stray GET to the callback cannot plant a refresh token: the
   code that comes back is only accepted if it carries a state this process
   issued. In memory is the right lifetime — the handshake is one browser
   round trip, minutes at most, and a value that survived a redeploy would be
   a value an attacker had longer to guess. A restart mid-handshake costs the
   reader one click on the link again, which is the correct trade. */
const pending = new Map();
const STATE_TTL_MS = 15 * 60 * 1000;
const sweep = () => {
  const now = Date.now();
  for (const [k, at] of pending) if (now - at > STATE_TTL_MS) pending.delete(k);
};
/* Constant time, because a state check that leaks its answer through timing is
   not a check. */
const stateOk = (given) => {
  sweep();
  const g = Buffer.from(String(given || ''));
  for (const k of pending.keys()) {
    const b = Buffer.from(k);
    if (b.length === g.length && timingSafeEqual(b, g)) { pending.delete(k); return true; }
  }
  return false;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* A page, not JSON. Whoever finishes this handshake is a person who has just
   come back from Tesla in a browser tab, and handing them a raw object is
   handing them a puzzle. */
const page = (title, body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{color-scheme:light dark}
  body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       max-width:34rem;margin:12vh auto;padding:0 1.25rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{margin:.6rem 0}
  code{background:rgba(127,127,127,.18);padding:.1rem .3rem;border-radius:4px}
  a{color:inherit}
</style>
<h1>${esc(title)}</h1>${body}`;

export function teslaRoutes(app, { q, wrap }) {
  /* WHAT WE HOLD AND WHAT IS MISSING, in one call.
     Deliberately answers even when nothing is configured: "no grant yet" is
     the single most useful thing this endpoint can say, and an endpoint that
     500s instead of saying it is an endpoint that hides its own answer. */
  app.get('/api/tesla/status', wrap(async (_req, res) => {
    await loadSettings(true);
    /* Our own side first — this is true whether or not Tesla ever answers,
       and it is what the section renders while the grant is missing. */
    const held = await q(`
      WITH spec AS (
        SELECT p.plate,
               coalesce(v.make,  vp.make)  AS make,
               coalesce(v.model, vp.model) AS model,
               coalesce(v.year,  vp.year)  AS year,
               coalesce(v.vin,   vp.vin)   AS vin,
               coalesce(v.fleet_id, vp.fleet_id) AS fleet_id
          FROM (SELECT plate FROM vehicle UNION SELECT plate FROM vehicle_plate) p
          LEFT JOIN vehicle       v  ON v.plate  = p.plate
          /* vehicle_plate, NEVER vehicle_profile ON plate: that table is keyed
             (platform, vehicle_ext_id) and holds one car once per channel, so
             joining it on plate doubles every aggregate. sql/schema_v66.sql. */
          LEFT JOIN vehicle_plate vp ON vp.plate = p.plate)
      SELECT model,
             count(*)::int AS plates,
             count(*) FILTER (WHERE vin IS NOT NULL AND vin <> '')::int AS with_vin,
             count(*) FILTER (WHERE fleet_id = 'ecosine')::int AS ecosine,
             count(*) FILTER (WHERE fleet_id = 'egari')::int AS egari
        FROM spec
       WHERE make ILIKE 'tesla%'
       GROUP BY model ORDER BY plates DESC`, []);

    const clientSet = !!get('TESLA_CLIENT_ID', '') && !!get('TESLA_CLIENT_SECRET', '');
    const granted = !!get('TESLA_REFRESH_TOKEN', '');
    let live = null;
    if (granted) {
      const t = await accessToken();
      live = t.err ? { ok: false, why: t.err } : { ok: true };
    }
    res.json({
      region: teslaRegion(), api_base: teslaBase(),
      /* Never the values, only whether they are set. */
      client_configured: clientSet,
      granted,
      live,
      teslas: held,
      total_teslas: held.reduce((a, r) => a + r.plates, 0),
      /* The sentence every surface prints while the grant is missing. One
         place, so the desktop and the phone cannot word it differently. */
      why: granted ? null
        : (clientSet
          ? 'The Tesla application is configured but nobody has approved it against the Tesla '
            + 'account that owns the cars. Those credentials authenticate the app, not the '
            + 'vehicles — until somebody signs in, Tesla answers with an empty list, and that '
            + 'is a fact about the grant rather than about the fleet.'
          : 'No Tesla client id and secret are set, so this application cannot even identify '
            + 'itself to Tesla yet.'),
    });
  }));

  /* THE LINK. Returned rather than redirected to, so it can be shown, copied
     and sent to whoever actually holds the Tesla account — which is very often
     not the person looking at this dashboard. */
  app.get('/api/tesla/connect', wrap(async (_req, res) => {
    await loadSettings(true);
    const state = randomBytes(24).toString('base64url');
    const url = authorizeUrl({ redirectUri: REDIRECT, state });
    if (!url) {
      return res.status(400).json({ error: 'TESLA_CLIENT_ID is not set, so no sign-in link can '
        + 'be built. Paste the client id and secret into Settings first.' });
    }
    pending.set(state, Date.now());
    res.json({ url, redirect_uri: REDIRECT, expires_in_min: STATE_TTL_MS / 60000,
      note: 'Open this as the person whose Tesla account owns the cars. Approving it grants '
        + 'read-only access — vehicle data and location, no commands.' });
  }));

  /* WHERE TESLA SENDS THEM BACK. */
  app.get('/teslaredirect', wrap(async (req, res) => {
    await loadSettings(true);
    const send = (title, body, code = 200) =>
      res.status(code).type('html').send(page(title, body));

    if (req.query.error) {
      return send('Tesla did not grant access',
        `<p>Tesla answered <code>${esc(req.query.error)}</code>.</p>`
        + `<p>${esc(req.query.error_description || 'No further detail was given.')}</p>`
        + '<p>Nothing has been changed here. You can start again from the Tesla page.</p>', 400);
    }
    const code = String(req.query.code || '');
    if (!code) {
      return send('Nothing to do',
        '<p>This is where Tesla sends you back after approving access, and it was opened '
        + 'without an approval attached. Start from the Tesla page in the dashboard.</p>', 400);
    }
    /* The state check. A code that arrives without one this process issued is
       not a code we asked for. */
    if (!stateOk(req.query.state)) {
      return send('That sign-in has expired',
        '<p>The approval came back without a request this server recognises — usually because '
        + 'it took more than fifteen minutes, or because the server restarted in between.</p>'
        + '<p><b>Nothing has been stored.</b> Open the link from the Tesla page again.</p>', 400);
    }
    const out = await exchangeCode({ code, redirectUri: REDIRECT });
    if (out.err) {
      return send('Tesla refused the exchange',
        `<p><code>${esc(out.err)}</code></p><p>Nothing has been stored.</p>`, 502);
    }
    await setSetting('TESLA_REFRESH_TOKEN', out.refresh, true);
    await loadSettings(true);
    return send('Tesla is connected',
      '<p>Access was granted and the token is stored. The dashboard can now read this '
      + 'account&rsquo;s vehicles.</p>'
      + '<p>You can close this tab and go back to the Tesla page.</p>');
  }));

  /* WHAT TESLA ACTUALLY RETURNS FOR US, asked live.
     Separate from /status because it costs a call against a pay-as-you-go
     tier, and because a page that renders on every load must not bill on
     every load. */
  app.get('/api/tesla/vehicles', wrap(async (_req, res) => {
    await loadSettings(true);
    const t = await accessToken();
    if (t.err) return res.status(409).json({ error: t.err, granted: false });
    if (t.refresh) await setSetting('TESLA_REFRESH_TOKEN', t.refresh, true);
    const { http } = await import('../src/http.js');
    const { data, status } = await http(`${teslaBase()}/api/1/vehicles`, {
      timeoutMs: 45000, retries: 1, headers: { authorization: `Bearer ${t.token}` } });
    const rows = Array.isArray(data?.response) ? data.response : [];
    res.json({ status, count: rows.length,
      /* Only the identifying and state fields — this is a diagnostic, not a
         dump of everything Tesla knows about a car. */
      vehicles: rows.map((v) => ({ vin: v.vin, display_name: v.display_name,
        state: v.state, id: v.id, vehicle_id: v.vehicle_id })),
      /* An empty list under a valid token is the ONE answer people misread,
         so it says what it means. */
      why: rows.length === 0
        ? 'The token is valid and Tesla returned no vehicles. That means the account that '
          + 'approved this application does not have the cars in it — a fleet is usually held '
          + 'in a Tesla Business account, and each car has to be in that account before it '
          + 'appears here.'
        : null });
  }));
}
