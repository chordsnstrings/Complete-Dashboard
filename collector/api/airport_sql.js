/* WHICH BOOKINGS ARE AIRPORT TRIPS — one strict rule, in SQL and in JS.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16: "add flight details and flights actually landing,
   and how that impacts the airport trips". The landings come from OpenSky
   (src/sources/flights.js); the airport trips have to come from our own
   bookings, and no booking carries a coordinate — Uber, Bolt and the hotel
   channel send an address as TEXT (pickup_addr / dropoff_addr) and nothing
   else. So "is this an airport trip" is a question asked of a sentence.

   THE OBVIOUS RULE IS WRONG, MEASURED. Production's /api/trips/list over
   17 Oct – 15 Nov 2026, every booking whose address matched airport, terminal,
   DXB, DWC, Maktoum, Int'l or International (read 2026-11-16, 432 distinct
   address strings):
     · the commonest "airport" address of all is "Airport Rd - Al Garhoud -
       Dubai" — 558 uses, more than any terminal. It is a road lined with
       warehouses, car showrooms and hotels (Le Meridien, Flora Inn "Dubai
       Airport"), not the terminal;
     · "Dubai International City" (Warsan, the Dragon Mart district), "Dubai
       Internet City", DIFC, Dubai International Academic City, "Dubai
       International Marine Club" and a dozen "… International School"s all
       contain "Dubai Int…";
     · "DXB" on its own is a code inside other things — "AE-DXB-YTS - Dubai
       Studio City", "DXB5 E-Fulfilment Centre", "DXB30 Al Falak Street Dubai
       Internet City", "Boho Salon. DXB";
     · "DWC" on its own is the district — "Dubai Logistics City DWC, Building
       A2, Office #207";
     · Google files the Dubai Airport Free Zone office park under "Dubai Int'l
       Airport" — "155 Al Quds St - Dubai Int'l Airport - Dubai Airport Free
       Zone", "DAFZA, Block A701", "7W, Block B - 4th Floor";
     · "opposite to Airport Terminal 3" is the Emirates Group headquarters and
       the Garhoud side of the road, and "Oppo Dubai Int'L Airport Terminal 3"
       is the same abbreviation;
     · the other airports are there too: Zayed International (Abu Dhabi,
       "Terminal A") and Sharjah International.

   THE RULE. An address is AT AN AIRPORT when it names the airport itself:
     DWC (Al Maktoum International, OMDW) — "Al Maktoum International
       Airport" (also cut short to "…International Air"), "Al Maktoum
       Airport", "(DWC)" in brackets, "DWC … Terminal", or in Arabic مطار آل
       مكتوم;
     DXB (Dubai International, OMDB) — "Dubai Int'l / International / Intl
       Airport", "(DXB)" in brackets (the hotel channel's "Terminal 1, Dubai
       International Airport (DXB)" and every language's "Flughafen Dubai
       (DXB)"), "DXB Terminal", "Terminal 1/2/3" together with the word
       airport (or مطار), or in Arabic مطار دبي;
   and it is NOT at an airport, whatever else it says, when it is the free
   zone (or Al Quds Street, the free zone's street: "143 Al Quds St - Dubai
   Int'l Airport"), "opposite"/"opp"/"oppo"/"near" something ("Street 13, Al
   Ramool - near to Dubai International Airport"), the E11 / Al Ittihad Road
   beside the field, a hotel or inn named after the airport, or another
   airport by name. "Terminal 3 Meeting Point- After Customs, at Exit 2" (the
   hotel channel's own wording) counts: a meeting point, customs, arrivals,
   departures or a concourse beside a terminal number stand in for the word
   airport. DWC is
   decided before DXB, because Arabic مطار دبي ورلد سنترال ("Dubai World
   Central airport") is DWC.

   Pickup and drop-off are classified SEPARATELY: an airport pickup is a
   passenger who has just landed; an airport drop-off is one about to fly. The
   impact page relates landings to pickups only.

   ONE SOURCE FOR BOTH ENGINES. The patterns are written once below as
   strings; JS compiles them with RegExp(…, 'i') and the SQL builder hands the
   same text to Postgres's ~* after turning JS's \b (word boundary) into
   Postgres's \y — in a Postgres regular expression \b is a BACKSPACE, and a
   copy that forgot that would quietly match nothing. Nothing here uses an
   apostrophe ("Int'l" is matched by int(ernationa|.)?l), so the SQL literal
   needs no escaping. test/airport_classifier.test.mjs runs every address
   above through BOTH and requires the same answer. */

export const AIRPORT_NAMES = {
  OMDB: { iata: 'DXB', name: 'Dubai International', lat: 25.2528, lon: 55.3644 },
  OMDW: { iata: 'DWC', name: 'Al Maktoum International', lat: 24.8960, lon: 55.1610 },
};

/* Not an airport, whatever else the address says. */
const NOT_AIRPORT = [
  'opposite', '\\bopp\\b', '\\boppo\\b', '\\bnear\\b',
  'free\\s*zone', '\\bdafza\\b', 'al\\s+quds\\s+st', 'al\\s+ittihad\\s+r', '\\be11\\b',
  '\\bhotel\\b', '\\binn\\b',
  /* Dubai's CRUISE terminals are numbered too: production holds "Mina Rashid,
     cruise terminal 3" and "Hamdan bin Mohammed Cruise terminal 3". Neither
     says airport today, but one carrying "Arrivals" would have been counted
     as DXB through TERMINAL + AIRWORD (integration 2026-11-16, the review's
     open item). */
  '\\bcruise\\b', 'mina\\s+rashid',
  'zayed\\s+international', 'abu\\s+dhabi\\s+international\\s+airport',
  'sharjah\\s+(international\\s+|intl\\.?\\s+)?airport', 'مطار\\s+الشارقة',
];
const DWC = [
  'al[\\s-]+maktoum[\\s-]+(international[\\s-]+)?air',
  '\\(dwc\\)', '\\bdwc\\b[^,]*terminal',
  'مطار\\s+آل\\s+مكتوم', 'ورلد\\s+سنترال',
];
const DXB = [
  'dubai[\\s-]+int(ernationa|.)?l\\.?[\\s-]+airport',
  '\\(dxb\\)', '\\bdxb\\s+terminal',
  'مطار\\s+دبي',
];
/* A terminal number counts only beside the word airport: "Terminal 1" alone
   could be a bus or a port terminal, and every real one in the sample says
   airport (or carries one of the DXB names above anyway). */
const TERMINAL = '\\bterminal\\s*[123]\\b';
const AIRWORD = 'airport|مطار|\\barrivals?\\b|\\bdepartures?\\b|meeting\\s+point|\\bcustoms\\b|\\bconcourse\\b';

const alt = (list) => list.map((p) => `(${p})`).join('|');
export const AIRPORT_PATTERNS = Object.freeze({
  not: alt(NOT_AIRPORT), dwc: alt(DWC), dxb: alt(DXB), terminal: TERMINAL, airword: AIRWORD,
});

const RX = Object.fromEntries(Object.entries(AIRPORT_PATTERNS).map(([k, p]) => [k, new RegExp(p, 'i')]));

/** Which airport an address names: 'OMDW', 'OMDB', or null. The JS twin of
    airportOfSql — the two must agree on every address (the test runs both). */
export function airportOfAddress(addr) {
  const a = String(addr ?? '');
  if (!a.trim() || RX.not.test(a)) return null;
  if (RX.dwc.test(a)) return 'OMDW';
  if (RX.dxb.test(a) || (RX.terminal.test(a) && RX.airword.test(a))) return 'OMDB';
  return null;
}

/* JS \b → Postgres \y. Applied to the pattern TEXT, so it is the same
   pattern in both engines and not a second copy. */
const pg = (p) => p.replace(/\\b/g, '\\y');

/** The same rule as a SQL expression over a text column: 'OMDW', 'OMDB' or
    NULL. `col` is a column reference the caller controls, never user input. */
export const airportOfSql = (col) => `(CASE
    WHEN ${col} IS NULL OR btrim(${col}) = '' THEN NULL
    WHEN ${col} ~* '${pg(AIRPORT_PATTERNS.not)}' THEN NULL
    WHEN ${col} ~* '${pg(AIRPORT_PATTERNS.dwc)}' THEN 'OMDW'
    WHEN ${col} ~* '${pg(AIRPORT_PATTERNS.dxb)}'
      OR (${col} ~* '${pg(AIRPORT_PATTERNS.terminal)}' AND ${col} ~* '${pg(AIRPORT_PATTERNS.airword)}') THEN 'OMDB'
  END)`;

/** The rule in one sentence, for the API and the page to print. */
export const AIRPORT_RULE = 'An address counts as the airport only when it names it — Dubai Int’l / '
  + 'International Airport, (DXB), a Terminal 1, 2 or 3 beside the word airport, Al Maktoum International '
  + 'Airport or (DWC). “Airport Rd – Al Garhoud”, the Dubai Airport Free Zone, “opposite Terminal 3”, Dubai '
  + 'International City, Internet City and DIFC are not the airport, and are not counted.';
