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

/* The `state` parameter, STORED rather than held in memory — and the reason
   is the whole shape of this handshake.
   ──────────────────────────────────────────────────────────────────────────
   It exists so a stray GET to the callback cannot plant a refresh token: the
   code that comes back is only accepted if it carries a state this server
   issued.

   This was a Map, on the reasoning that a handshake is one browser round trip
   and a value surviving a redeploy is a value an attacker has longer to guess
   — "a restart mid-handshake costs the reader one click on the link again,
   which is the correct trade". That reasoning describes somebody signing in at
   their own keyboard, and it is not what this link is for. /api/tesla/connect
   RETURNS the URL rather than redirecting to it precisely so it can be shown,
   copied and sent to whoever actually holds the Tesla account, who is usually
   not the person looking at the dashboard. A link built to be forwarded, that
   dies in fifteen minutes and cannot outlive a basic-xxs container recycling,
   fails in exactly its intended use.

   It did, on the first real attempt: the operator opened the link and got
   "That sign-in has expired" having done nothing wrong. The trade was wrong,
   so it is reversed.

   WHAT IS NOT GIVEN UP. The value is still 24 random bytes from
   randomBytes — 192 bits, which an hour of guessing does not dent — still
   compared in constant time, and still SINGLE USE: the first match clears it,
   so a replayed callback is refused like any stranger's. What it gains is an
   expiry that is written down instead of being an accident of process
   lifetime, and a handshake that survives the deploy that happens to land
   while somebody is reading their email. */
const STATE_TTL_MS = 60 * 60 * 1000;
const STATE_KEY = 'TESLA_OAUTH_STATE';

/* Stored as `<state>.<expiry-ms>` rather than JSON: one row, one string, and
   nothing to parse defensively on a path where a parse failure would lock the
   only way in. Anything unreadable is treated as no pending sign-in. */
const putState = (state) => setSetting(STATE_KEY, `${state}.${Date.now() + STATE_TTL_MS}`);

const readState = () => {
  const raw = String(get(STATE_KEY, '') || '');
  const cut = raw.lastIndexOf('.');
  if (cut < 1) return null;
  const until = Number(raw.slice(cut + 1));
  if (!Number.isFinite(until) || Date.now() > until) return null;
  return raw.slice(0, cut);
};

/* Constant time, because a state check that leaks its answer through timing is
   not a check. Consumed on success — a state that has been used is not a state
   this server issued any more. */
const stateOk = async (given) => {
  const held = readState();
  if (!held) return false;
  const g = Buffer.from(String(given || ''));
  const b = Buffer.from(held);
  if (b.length !== g.length || !timingSafeEqual(b, g)) return false;
  await setSetting(STATE_KEY, '');
  return true;
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
    /* Awaited: a link handed out before its state is stored is a link that
       races the reader, and the reader wins often enough to matter. */
    await putState(state);
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
    if (!(await stateOk(req.query.state))) {
      return send('That sign-in has expired',
        '<p>The approval came back without a sign-in this server is waiting for. A link lasts an '
        + 'hour, and it can only be used once — so this is either an hour old, or it has already '
        + 'been used, or a newer link was asked for and replaced it.</p>'
        + '<p><b>Nothing has been stored, and nothing is broken.</b> Open the Tesla page in the '
        + 'dashboard and ask for a new link.</p>', 400);
    }
    const out = await exchangeCode({ code, redirectUri: REDIRECT });
    if (out.err) {
      /* HTTP 200, AND THE STATUS CODE IS THE POINT.
         ──────────────────────────────────────────────────────────────────
         This answered 502, which is semantically right and operationally
         useless: DigitalOcean's edge replaces the body of a 5xx with its own
         "Well, This is unexpected" page, so the explanation written three
         lines above never reached the person reading it. The operator saw a
         generic 502 twice and had no way to tell an edge block from a bad
         secret — the exact substitution of a reason for a shrug that this
         product exists to refuse.

         The page IS the answer, so it is delivered with a status that lets it
         through. The failure is still named in the log and still named on the
         screen; only the code changes. */
      const edge = out.edge;
      return send(edge ? 'Tesla would not accept the request from this server'
        : 'Tesla refused the sign-in',
        `<p>${esc(out.err)}</p>`
        + (edge
          ? '<p>The approval itself worked — Tesla sent us back a valid code. What failed is '
            + 'this server exchanging that code for a token, and it failed at Tesla&rsquo;s front '
            + 'door rather than at the sign-in.</p>'
            + '<p><b>Nothing has been stored, and nothing you did was wrong.</b> This needs '
            + 'fixing on our side, not by trying again.</p>'
          : '<p><b>Nothing has been stored.</b> You can start again from the Tesla page.</p>'));
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
    /* The rotated refresh token is stored by accessToken() itself now — see
       src/auth/tesla.js. It was stored here and NOT in the other caller, which
       is exactly the asymmetry that made /api/tesla/status sign the fleet out. */
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
