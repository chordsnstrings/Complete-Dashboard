/* EGARI'S HOTEL BOOKINGS WERE NEVER READ, AND THE VERDICT SAID THEY WERE.
   ─────────────────────────────────────────────────────────────────────────
   Reported 2026-10-05: an FMS journey on Egari's L-64172, 05:30 to 05:54 UTC,
   read "unauthorized — no booking of any kind on this plate in the window,
   across bolt, hotel, uber, yango", and the operator holds the hotel booking
   for it (05:31 to 06:08, a named driver). Measured the same day: of 2,568
   hotel bookings stored over a year, 0 are on any of the 40 Egari plates. The
   one hotel account read is Ecosine's (hotel.ecosine.ae); every booking
   carries Ecosine's `company` id. So hotel was never checked for Egari, and
   78 Egari journeys that month were called unauthorized on that basis.

   What this pins:
     1. uncollectedByFleet(): a channel read for one fleet and never for
        another is uncollected for the other; read for none, it is left to
        blockingChannels() (not configured); read for both, nothing fires.
     2. judgeSegment(): an Egari journey with no booking is unverifiable with
        a reason that names the gap; an Ecosine one is still unauthorized.
     3. channels_checked drops a channel uncollected for the segment's fleet.
     4. config.hotels: an Egari slot, x-domain hotel.egari.ae by default,
        its own HOTEL_EGARI_TOKEN — the Egari operations manager is a separate
        user (measured with its bearer: company 688f12af…, L-64172 05:31:37–
        06:08:33 finished AED 125), so Ecosine's is never borrowed.
     5. src/sources/hotel.js: every account is collected; each credential
        verdict names its own key; a booking stored under another fleet is
        never refiled; `total` is in scope for the error run.
     6. Settings paste (src/credkit.js): a hotel bearer is recognised bare, as
        `HOTEL_EGARI_TOKEN=…`, in a curl, or in a Postman collection holding
        BOTH fleets in one block, and filed by the x-domain beside it.
     7. checkHotel (src/credcheck.js): the tenant that accepts a bearer names
        its fleet; the other answers 401 "You are not registered with this
        company" (measured with both real bearers on both domains). */
import { readFileSync } from 'node:fs';
import { uncollectedByFleet, uncollectedReason, judgeSegment } from '../src/reconcile.js';
import { recognise, unrecognised } from '../src/credkit.js';
import { checkHotel } from '../src/credcheck.js';
import { config } from '../src/config.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const HOTELS = [{ fleet: 'ecosine' }, { fleet: 'egari' }];

console.log('1. uncollected per fleet, judged on what was read');
{
  const ecoOnly = uncollectedByFleet(HOTELS, [{ platform: 'hotel', fleet_id: 'ecosine', n: 2568 },
    { platform: 'uber', fleet_id: 'egari', n: 900 }]);
  check('hotel read for Ecosine only → uncollected for Egari', JSON.stringify([...ecoOnly]) === '[["egari",["hotel"]]]',
    JSON.stringify([...ecoOnly]));
  const none = uncollectedByFleet(HOTELS, [{ platform: 'uber', fleet_id: 'egari', n: 900 }]);
  check('hotel read for no fleet → left to blockingChannels (nothing here)', none.size === 0);
  const both = uncollectedByFleet(HOTELS, [{ platform: 'hotel', fleet_id: 'ecosine', n: 5 },
    { platform: 'hotel', fleet_id: 'egari', n: 1 }]);
  check('one Egari booking lands → the guard lifts', both.size === 0);
  const zero = uncollectedByFleet(HOTELS, [{ platform: 'hotel', fleet_id: 'ecosine', n: 5 },
    { platform: 'hotel', fleet_id: 'egari', n: 0 }]);
  check('a zero count is not a read', zero.has('egari'));
}

console.log('2. the verdict');
{
  const now = Date.now();
  const seg = (fleet) => ({ plate: 'L64172', fleet_id: fleet,
    started_at: new Date(now - 8 * 3600e3).toISOString(), ended_at: new Date(now - 7.6 * 3600e3).toISOString(),
    gapBefore: 30, gapAfter: 30 });
  const ctx = { bookingsByPlate: new Map(), bookingIndex: null, judgeBefore: now, unavailable: [],
    configured: ['bolt', 'hotel', 'uber', 'yango'], inWindow: new Set(['bolt', 'hotel', 'uber', 'yango']),
    clockSuspect: false, medianLag: 0,
    uncollected: new Map([['egari', ['hotel']]]) };
  const eg = judgeSegment(seg('egari'), 'candidate', ctx);
  check('Egari, no booking, hotel unread → unverifiable', eg.verdict === 'unverifiable', JSON.stringify(eg));
  check('…and the reason names the gap, not "across … hotel"',
    /no Egari hotel booking has ever been collected/.test(eg.reason) && !/across/.test(eg.reason), eg.reason);
  const eco = judgeSegment(seg('ecosine'), 'candidate', ctx);
  check('Ecosine, no booking → still unauthorized', eco.verdict === 'unauthorized', JSON.stringify(eco));
  check('uncollectedReason capitalises the fleet', uncollectedReason('egari', ['hotel']).startsWith('no Egari hotel'));
}

const rec = readFileSync(new URL('../src/reconcile.js', import.meta.url), 'utf8');
console.log('3. channels_checked and the per-fleet read');
check('channels_checked drops what is unread for the fleet', rec.includes('inWindow.has(c) && !notRead.has(c)'));
check('ever is counted per platform AND fleet', /GROUP BY platform, fleet_id/.test(rec));
check('the pass hands the per-fleet set to every verdict', rec.includes('uncollected: uncollectedByFleet(config.hotels, ever)'));

console.log('4. config.hotels');
{
  const saved = { ...process.env };
  delete process.env.HOTEL_EGARI_TOKEN; delete process.env.HOTEL_EGARI_DOMAIN;
  process.env.HOTEL_TOKEN = 'synthetic-eco';
  const [eco, eg] = config.hotels;
  check('Ecosine first, as before', eco.fleet === 'ecosine' && eco.cred === 'HOTEL_TOKEN');
  check('Egari defaults to hotel.egari.ae', eg.fleet === 'egari' && eg.domain === 'hotel.egari.ae');
  check('…and never borrows the Ecosine bearer (a separate operator user)', !eg.token);
  process.env.HOTEL_EGARI_TOKEN = 'synthetic-egari';
  const eg2 = config.hotels[1];
  check('its own token, named for the banner', eg2.cred === 'HOTEL_EGARI_TOKEN' && eg2.token === 'synthetic-egari');
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

const src = readFileSync(new URL('../src/sources/hotel.js', import.meta.url), 'utf8');
console.log('5. the collector');
check('every account is collected', /for \(const c of config\.hotels\)/.test(src));
check('each verdict names the account\'s own key (3 of 3)',
  (src.match(/credential: c\.cred \|\| 'HOTEL_TOKEN'/g) || []).length === 3);
check('an account with no token is skipped, not guessed', /if \(!c\.token \|\| !c\.domain\)/.test(src));
check('a booking stored under another fleet is never refiled',
  src.includes('fleet_id IS DISTINCT FROM $3') && src.includes("upsertMany('trip', mine,"));
check('total is declared before the try', /let total = 0;\n  try \{\n    await loadHotels\(c\)/.test(src));

console.log('6. pasting a hotel bearer into Settings');
{
  /* Synthetic bearers in the platform's shape — {id, role, iat}, no exp. */
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (id, role = 'operation_manager') => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id, role, iat: 1782652555 })}.c2lnbmF0dXJlLXN5bnRoZXRpYw`;
  const EG = jwt('egari-manager-0001'), ECO = jwt('ecosine-manager-01');
  const postman = JSON.stringify({ info: { name: 'Hotel' }, item: [
    { name: 'Egari Trips', request: { header: [{ key: 'Authorization', value: `Bearer ${EG}` }, { key: 'x-domain', value: 'hotel.egari.ae' }],
      url: { raw: 'https://whale-app-iofbt.ondigitalocean.app/api/operation-managers/report/get-trip-report?startDate=2026-10-01' } } },
    { name: 'Ecosine Trips', request: { header: [{ key: 'Authorization', value: `Bearer ${ECO}` }, { key: 'x-domain', value: 'hotel.ecosine.ae' }],
      url: { raw: 'https://whale-app-iofbt.ondigitalocean.app/api/operation-managers/report/get-trip-report?startDate=2026-09-08' } } },
  ] }, null, 2);
  const r = recognise(postman);
  const by = Object.fromEntries(r.map((c) => [c.key, c]));
  check('a Postman collection with both fleets yields two bearers', r.length === 2, JSON.stringify(r.map((c) => c.key)));
  check('…Egari\'s filed under HOTEL_EGARI_TOKEN', by.HOTEL_EGARI_TOKEN?.value === EG && by.HOTEL_EGARI_TOKEN.fleet === 'egari');
  check('…Ecosine\'s under HOTEL_TOKEN', by.HOTEL_TOKEN?.value === ECO && by.HOTEL_TOKEN.fleet === 'ecosine');
  check('…and nothing in it is left for the model to read', unrecognised(postman).length === 0);
  const curl = recognise(`curl 'https://whale-app-iofbt.ondigitalocean.app/api/x' -H 'x-domain: hotel.egari.ae' -H 'Authorization: Bearer ${EG}'`);
  check('a curl is filed by its x-domain', curl.length === 1 && curl[0].key === 'HOTEL_EGARI_TOKEN' && curl[0].ok);
  const bare = recognise(EG);
  check('a bare bearer arrives keyless, for the check to file', bare.length === 1 && bare[0].key === null
    && bare[0].ok === true && bare[0].kind === 'hotel');
  const labelled = recognise(`HOTEL_EGARI_TOKEN=${EG}`);
  check('a labelled one is still a hotel bearer, filed by the tenant', labelled[0]?.kind === 'hotel' && labelled[0].value === EG);
  const odd = recognise(`-H 'x-domain: hotel.example.com' -H 'Authorization: Bearer ${EG}'`);
  check('an x-domain we do not read is refused', odd[0]?.ok === false && /not a hotel account/.test(odd[0].why));
  check('a JWT of another role is not taken for a hotel bearer', recognise(jwt('x', 'driver')).every((c) => c.kind !== 'hotel'));
}

console.log('7. the live check names the fleet');
{
  const NOT = { status: 401, data: { status: false, error: 'You are not registered with this company' } };
  const OK = { status: 200, data: { data: [{ _id: 'a' }, { _id: 'b' }] } };
  const asked = [];
  const egOnly = async (acct, domain) => { asked.push(domain); return domain === 'hotel.egari.ae' ? OK : NOT; };
  const k = await checkHotel({ key: null, value: 'x' }, { fetchHotel: egOnly });
  check('keyless: tried on each tenant, filed under the one that accepts it', k.verdict === 'pass'
    && k.key === 'HOTEL_EGARI_TOKEN' && k.fleet === 'egari' && asked.join() === 'hotel.ecosine.ae,hotel.egari.ae', JSON.stringify(k));
  asked.length = 0;
  const keyed = await checkHotel({ key: 'HOTEL_TOKEN', value: 'x' }, { fetchHotel: egOnly });
  check('keyed: tried on its own tenant only, and refused there', keyed.verdict === 'fail' && asked.join() === 'hotel.ecosine.ae'
    && /not registered with this company/.test(keyed.detail), JSON.stringify(keyed));
  const down = await checkHotel({ key: 'HOTEL_EGARI_TOKEN', value: 'x' }, { fetchHotel: async () => { throw new Error('ECONNRESET'); } });
  check('unreachable is unknown, not fail', down.verdict === 'unknown');
  const cc = readFileSync(new URL('../src/credcheck.js', import.meta.url), 'utf8');
  check('both hotel keys are routed to checkHotel on save', /HOTEL_TOKEN: checkHotel,\s*HOTEL_EGARI_TOKEN: checkHotel/.test(cc));
  check('a keyless hotel bearer is routed before the key test', cc.includes("cand.kind === 'hotel' && !cand.key"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
