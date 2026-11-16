/* Every pickup and drop-off placed, or absent for a reason that is true.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT. The driver Territory tab's "Busiest pickup areas" grouped by
   place_area(pickup_addr) and filed every address it could not read under
   "(unparsed)" — the second-largest row on the page the operator was looking
   at on 2026-11-16, 35 of ~230 pickups. place_area() (sql/schema_v68.sql)
   reads ONE address shape, Google's dash form "X - Area - Dubai - United Arab
   Emirates", and returns NULL for everything else. Measured on production
   over GET /api/trips/list, 6,000 bookings, 9–15 Nov 2026:

     Uber    1,003 of 5,550 pickups unread (18%):
               456 in Uber's ONE-LINE form, no dashes at all
                   ("Al Zarouni Block A Al Muraqqabat Deira AE")
               401 with an EMPTY pickup address (~7% every day, evenly)
               111 mostly Arabic, 31 "Dubai - United Arab Emirates" alone,
                 2 bare plus codes ("35J6+VH - Dubai - United Arab Emirates")
     Bolt      176 of 199 unread (88%): the COMMA form
               ("Sheikh Rashid Road 137, Dubai")
     Yango      23 of 23 unread: the comma form, Yandex's hierarchy
               ("Shemara Tower, Jumeirah Beach Residence, Dubai Marina, …")
     Hotel     ~0%: dash form, one plus code

   None of those is unknowable. The text names an area in a shape the parser
   did not read; a plus code IS a position; and the car the booking was driven
   in has a tracker that reports every ~6 minutes. So each endpoint now walks a
   ladder, most direct evidence first, and the answer carries the rung it came
   from — its BASIS — so a page can say how it knows:

     1. address       the dash form, place_area() exactly as before. Where the
                      old rule worked, nothing changes.
     2. address_name  the one-line and comma forms: a name the fleet's own
                      history already uses, found in the text (matchName).
     3. plus_code     an Open Location Code in the text, decoded, then named by
                      the gazetteer (place_cell).
     4. coordinates   the booking's own lat/lng, where the platform sent one,
                      named by the gazetteer.
     5. tracker       the car's own tracker fix nearest the request time
                      (pickup) or the drop-off time, within TRACKER_WINDOW_MIN,
                      named by the gazetteer. This is where the CAR was, not
                      what the platform wrote, and every surface says so.
     6. absent        with the reason the whole ladder failed, in words
                      (reasonText) — never "(unparsed)".

   This module is pure: no database, no clock. src/trip_places.js feeds it a
   batch of trips, the gazetteer and the vocabulary, and stores what it says. */

/* ── 1. the dash form: a JavaScript twin of place_area() ───────────────────
   The SQL function stays the authority — it is IMMUTABLE and sits inside
   indexes and queries this change does not touch. This twin exists so the
   ladder can run in one place, and test/place_resolve.test.mjs asserts the two
   agree on every fixture string, against PGlite running the real function.
   Same three steps: trim spaces and commas, split on ' - ' and drop blank
   segments, take the third from the end; refuse a code or a bare number. */
export function placeArea(addr) {
  const s = String(addr ?? '').replace(/^[ ,]+|[ ,]+$/g, '');
  const a = s.split(' - ').map((x) => x.trim()).filter((x) => x !== '');
  if (a.length < 3) return null;
  const c = a[a.length - 3];
  const nameLike = /[a-z]/.test(c) || !/[0-9]/.test(c) || /\s/.test(c);
  if (!nameLike) return null;
  if (/^[A-Z]{0,2} ?[0-9]+$/.test(c)) return null;
  return c;
}

/* ── 2. the one-line and comma forms: names the fleet already uses ─────────
   Not a geocoder and not a fuzzy matcher. The vocabulary is the set of area
   names this database has already produced — place_area() over the trip
   history plus the names place_cell holds (src/trip_places.js builds it) —
   so a name recovered here is spelled exactly as the same place is spelled on
   every other row, and the Territory list cannot grow a second "Dubai
   Marina".

   THE RULES, each one from a case the first rough matcher got wrong on the
   production sample:

   * GENERIC names never match. A rough matcher over 330 names returned
     "Dubai" — true and useless, the city every booking is in. A name made
     only of city, emirate, country and filler words (GENERIC + STOP below)
     is not an area and is dropped from the vocabulary.
   * LATIN SCRIPT ONLY. The same matcher once matched an Arabic-script name
     on a stray "1": tokenising an Arabic name leaves its digits behind. Names
     carrying any non-Latin letter are dropped, a name must carry a word of at
     least three letters, and non-Latin text in an ADDRESS is a barrier a name
     cannot match across ("Duja Tower شارع 6 Sheikh Zayed Road" cannot yield
     a name that straddles the Arabic).
   * NEAREST THE END, then LONGEST. Every shape lists most specific first and
     the city last: Uber's one-line form is the dash form with the dashes,
     the city and the country dropped ("… Al Muraqqabat Deira AE"), so the
     name nearest the end is the one place_area() would have taken from the
     dash form of the same address — "Deira" — and the two shapes of one place
     land in one row. Among names ending at the same word the longer wins:
     "Pearl Jumeirah" over "Jumeirah".
   * WEAK names match only when nothing else does. Yandex (Yango) inserts
     "Jumeirah" as a district ABOVE Dubai Marina — "…, Dubai Marina, Jumeirah,
     Dubai" — where Google's dash form of the same place says "Dubai Marina".
     Alone it is still the best the text offers, so it is kept as a fallback.
   * Commas, semicolons and ' - ' are barriers too: a name never spans two
     parts of an address.

   THE INDEPENDENT REVIEW (2026-11-16) found the matcher above still naming
   things that are not areas — a wrong area is worse than an absent one,
   because an absent pickup goes on to the tracker and a wrong one stops
   there. Run over the production sample's 5,550 Uber, 199 Bolt and 23 Yango
   pickups with the fixture vocabulary (place_area() names plus the
   place_cell names) and the sample's own place_area() answers, 508 pickups
   were named; 70 of those names are gone under the rules below (59 roads
   or "District"), and 4 pickups gained a name:
     · ROADS, from place_cell's vocabulary — FMS's reverse geocoder names a
       fix by its road ("Sheikh Zayed Rd", "Airport Rd", "Umm Suqeim St"),
       and the matcher found those words in "Duja Tower شارع 6 Sheikh Zayed
       Road AE" (15), "Le Meridien Hotel Airport Road Garhoud AE" (13),
       "King's Dubai School Umm Suqeim Street Hadaeq Sheikh Mohammad Bin
       Rashid AE". Sheikh Zayed Road is fifty kilometres long; it is not
       where a pickup was. A name whose last word is a road word is not an
       area, and neither is an area name used AS a road name — "Al Safa
       Street Taxi Terminal, City Walk Mall" is on Al Safa Street, in Al
       Wasl; "Umm Suqeim Street 145" can be in Al Barsha.
     · "District" (13), "District 2", "Zone 1", "Industrial Area": place
       kinds, not places. Uber writes "District 1 Al Worood 1 Street Al
       Thanyah AE"; the matcher found "District". AREA_KIND below joins
       STOP so a name made only of them carries no real word.
     · BUILDINGS and businesses in place_cell's vocabulary ("Latifa
       Hospital", "Lake Central Tower", "Onpassive Metro Station", "near to
       Novotel hotel"). A name carrying a POI word is not an area.
     · FRAGMENTS of a longer place: "Layan Community K Road Wadi Al Safa 7,
       Dubai Land AE" came back "Al Safa" — a community twenty kilometres
       from Wadi Al Safa — because "Wadi Al Safa 7" is not in the
       vocabulary and "Al Safa" is a sub-sequence of it. A match whose
       neighbouring word continues a LONGER known name ("Wadi Al Safa 5"
       precedes "Al Safa" with "Wadi") is part of that name, and is not
       taken.
     · the WEAK "Jumeirah" as a hotel brand or a fragment: "Jumeirah
       Emirates Towers Hotel Entrance, Museum Of The Future …" (Trade
       Centre), "Jumeirah Beach Hotel Jumeirah Road Umm Suqiem 3 AE",
       "Gmm Tower lolow street Jumeirah Village AE" (JVC, twenty kilometres
       away). The weak name now answers only where it stands as the
       district itself: alone in its part ("…, Jumeirah, Dubai", "…
       Jumeirah AE") or as "Jumeirah 1/2/3".
   Each rule is pinned in test/place_resolve.test.mjs on the string that
   needed it. */
const GENERIC = new Set(['dubai', 'uae', 'ae', 'united', 'arab', 'emirates', 'emirate',
  'sharjah', 'ajman', 'abu', 'dhabi', 'fujairah', 'ras', 'khaimah', 'umm', 'quwain']);
/* Kinds of place, not places: a name made only of these (and digits) names
   nothing — "District 2", "Zone 1", "Industrial Area". */
const AREA_KIND = ['district', 'zone', 'phase', 'sector', 'industrial', 'residential', 'community',
  'complex', 'suburb', 'city', 'business', 'centre', 'center'];
const STOP = new Set(['al', 'el', 'the', 'of', 'and', 'st', 'rd', 'dr', 'street', 'road', 'drive',
  'no', 'tower', 'building', 'bldg', 'block', 'level', 'floor', 'villa', 'apartment', 'apt',
  'office', 'shop', 'unit', 'gate', 'entrance', 'exit', 'near', 'opp', 'opposite', 'behind',
  'unnamed', 'area', ...AREA_KIND]);
/* Road words, as tokens() folds them (road→rd, street→st, drive→dr). */
const ROAD = new Set(['rd', 'st', 'dr', 'hwy', 'highway', 'blvd', 'boulevard', 'ave', 'avenue', 'bridge',
  'interchange', 'flyover']);
/* A name carrying one of these names a building or a business, not an
   area. "towers" (plural) is not here: Jumeirah Lake Towers is a community. */
const POI = new Set(['hotel', 'hotels', 'hospital', 'clinic', 'restaurant', 'cafe', 'metro', 'station',
  'bus', 'stop', 'school', 'university', 'bank', 'headquarters', 'hq', 'floor', 'tower', 'building', 'bldg',
  'mall', 'near', 'next', 'beside', 'opp', 'opposite', 'shop', 'office', 'plot', 'gate', 'entrance',
  'apartment', 'apartments', 'suites']);
const HOTEL = new Set(['hotel', 'hotels', 'resort']);
const WEAK = new Set(['jumeirah']);
/* The words Google abbreviates in its own addresses ("Marasi Dr", "Sheikh
   Zayed Rd", "Al Falak St", "Dubai Int'l Airport") and the other forms spell
   out. Both sides of the match are folded the same way, and the name returned
   is the vocabulary's own spelling, so "Dubai International Airport, Terminal
   3" (Yango) comes back as "Dubai Int'l Airport" — the spelling every
   dash-form row of the airport uses. */
const FOLD = new Map([['road', 'rd'], ['street', 'st'], ['drive', 'dr'], ['international', 'intl']]);
const BARRIER = '|';

/* Lower case, accents off, apostrophes joined ("Int'l" → "intl"), every
   non-Latin run and every comma, semicolon or ' - ' turned into a barrier. */
export function tokens(text) {
  const s = String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/ - |[,;]/g, ` ${BARRIER} `)
    .replace(/[^\x00-\x7f]+/g, ` ${BARRIER} `);
  return s.split(/[^a-z0-9|]+/).filter(Boolean)
    .map((t) => (t.includes(BARRIER) ? BARRIER : FOLD.get(t) ?? t));
}

const LATIN = /^[\x00-\x7f]*$/;

/* Whether a name is an AREA the matcher may return. Exported so the
   vocabulary rules are tested directly rather than through a match. */
export function vocabularyName(name) {
  const plain = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (!plain.trim() || !LATIN.test(plain)) return false;
  /* place_area()'s own refusal, applied to the name as a whole: a digit with
     no lowercase letter and no space is a code ("57VWG8", "W44"), and so is a
     bare number with a road letter in front ("E 11"). */
  const s = plain.trim();
  if ((/[0-9]/.test(s) && !/[a-z]/.test(s) && !/\s/.test(s)) || /^[A-Z]{0,2} ?[0-9]+$/.test(s)) return false;
  /* A name with a comma or semicolon in it is two things glued together by
     a segment place_area() could not split — "Al Mawakeb Al Garhoud, Al
     Garhoud", "Number One Tower Suites Dubai, Sheikh Zayed Road", "Al Barsha
     1, Al Barsha 1" — a building and its area, or the area twice. It is not
     one area's name, and its pieces would teach the fragment rule below
     contexts that are not real ("Al Garhoud" preceded by "Garhoud"). */
  const raw = tokens(plain);
  if (raw.includes(BARRIER)) return false;
  const t = raw;
  /* A road is not an area: the last word, past any trailing number
     ("Manama Road 6 1"), is a road word — "Sheikh Zayed Rd", "Al Seef St",
     "Festival Blvd", "Al Garhoud Bridge". */
  const words = t.filter((x) => !/^[0-9]+$/.test(x));
  if (words.length && ROAD.has(words[words.length - 1])) return false;
  /* Nor is a building or a business: "Latifa Hospital", "Panoramic Tower". */
  if (t.some((x) => POI.has(x))) return false;
  /* A real WORD — three letters or more, letters only, not the city and not
     filler — has to be in it; "Street 6" and "Tower 2" have none. */
  return t.some((x) => /^[a-z]{3,}$/.test(x) && !GENERIC.has(x) && !STOP.has(x));
}

/* entries: [{ name, n }] — n is how many trip endpoints or cells used the
   name. minN drops names one trip produced: a stray reverse-geocode is not an
   area until a second observation agrees it exists. Where two names fold to
   the same tokens ("Sheikh Zayed Road" and "Sheikh Zayed Rd"), the more used
   spelling is kept. */
export function buildVocabulary(entries, { minN = 2 } = {}) {
  const byKey = new Map();
  for (const e of entries || []) {
    const n = Number(e.n) || 0;
    if (n < minN || !vocabularyName(e.name)) continue;
    const t = tokens(e.name).filter((x) => x !== BARRIER);
    const key = t.join(' ');
    const prev = byKey.get(key);
    if (!prev || n > prev.n || (n === prev.n && e.name < prev.name)) byKey.set(key, { name: e.name, t, n });
  }
  const byFirst = new Map();
  for (const v of byKey.values()) {
    if (!byFirst.has(v.t[0])) byFirst.set(v.t[0], []);
    byFirst.get(v.t[0]).push(v);
    v.left = new Set();
    v.right = new Set();
  }
  /* Where each name sits INSIDE a longer one: the word just before it and
     just after it in every longer vocabulary name that contains it. "Al
     Safa" sits in "Wadi Al Safa 5" with "wadi" on its left, so in "… Wadi Al
     Safa 7 …" it is a fragment of a Wadi Al Safa, not Al Safa (review
     2026-11-16). Once per build: names × their sub-sequences, a few
     thousand look-ups. */
  for (const w of byKey.values()) {
    for (let a = 0; a < w.t.length; a++) {
      for (let b = a + 1; b <= w.t.length; b++) {
        if (b - a === w.t.length) continue;
        const inner = byKey.get(w.t.slice(a, b).join(' '));
        if (!inner) continue;
        if (a > 0) inner.left.add(w.t[a - 1]);
        if (b < w.t.length) inner.right.add(w.t[b]);
      }
    }
  }
  return { byFirst, size: byKey.size };
}

/* The name in an address, or null. Returns the vocabulary's own spelling. */
export function matchName(addr, vocab) {
  if (!vocab || !vocab.size) return null;
  const t = tokens(addr);
  let best = null;
  let weak = null;
  for (let i = 0; i < t.length; i++) {
    for (const v of vocab.byFirst.get(t[i]) || []) {
      if (i + v.t.length > t.length) continue;
      let ok = true;
      for (let j = 1; j < v.t.length; j++) if (t[i + j] !== v.t[j]) { ok = false; break; }
      if (!ok) continue;
      const end = i + v.t.length - 1;
      const next = t[end + 1];
      /* An area name used as a road name names the road: "Al Safa Street",
         "Umm Suqeim Street 145", "Palm Jumeirah Rd 9". */
      if (next && ROAD.has(next)) continue;
      /* A fragment of a longer known name ("Al Safa" in "Wadi Al Safa 7"). */
      if ((i > 0 && v.left?.has(t[i - 1])) || (next && v.right?.has(next))) continue;
      /* The name of a hotel, not where it is: the Jumeirah Beach Hotel is in
         Umm Suqeim 3. */
      if (next && HOTEL.has(next)) continue;
      const m = { name: v.name, end, len: v.t.length, n: v.n };
      const better = (a, b) => !b || a.end > b.end || (a.end === b.end
        && (a.len > b.len || (a.len === b.len && a.n > b.n)));
      if (v.t.length === 1 && WEAK.has(v.t[0])) {
        /* The weak name answers only as the district itself: alone in its
           part (everything after it, to the next barrier, is the city or
           the country) or as Jumeirah 1, 2 or 3 — never as the brand in
           "Jumeirah Emirates Towers Hotel" or the start of "Jumeirah
           Village". */
        let k = end + 1;
        while (k < t.length && t[k] !== BARRIER && GENERIC.has(t[k])) k++;
        const alone = k >= t.length || t[k] === BARRIER;
        if (!alone && !/^[1-3]$/.test(next || '')) continue;
        if (better(m, weak)) weak = m;
      } else if (better(m, best)) best = m;
    }
  }
  const m = best || weak;
  return m ? m.name : null;
}

/* What the address text says when no area could be read from it — the first
   half of an absent endpoint's reason. */
export function textFailure(addr) {
  const s = String(addr ?? '').trim();
  if (!s) return 'no_address';
  const t = tokens(s).filter((x) => x !== BARRIER);
  if (t.length && t.every((x) => GENERIC.has(x))) return 'city_only';
  /* "阿拉伯联合酋长国迪拜酋长国", "شارع 6 AE": no Latin word to read. That is
     not "names no area" — it may well name one — so it says what is true:
     the matcher reads Latin script only. */
  if (!t.some((x) => /[a-z]{2,}/.test(x) && !GENERIC.has(x))) return 'other_script';
  return 'unknown_name';
}

/* Abu Dhabi's dash form carries a municipal zone code where Dubai's carries
   the community — "Nation Towers - Corniche St - Al Bateen - W44 - Abu Dhabi
   - United Arab Emirates" — so place_area() reads "W44", refuses it as a
   code, and returns NULL. The community is the segment before the code. 14
   of the sample's 11,100 endpoints; read here rather than by changing
   place_area(), which is IMMUTABLE and sits in indexes this does not touch. */
const ZONE = /^[A-Z]{1,2}[0-9]{1,2}$/;
export function zoneArea(addr) {
  const s = String(addr ?? '').replace(/^[ ,]+|[ ,]+$/g, '');
  const a = s.split(' - ').map((x) => x.trim()).filter((x) => x !== '');
  if (a.length < 4 || !ZONE.test(a[a.length - 3])) return null;
  const c = a[a.length - 4];
  return vocabularyName(c) ? c : null;
}

/* ── 3. plus codes: Open Location Code, decoded here ───────────────────────
   Google prints a SHORT code when the locality follows it: "35J6+VH - Dubai -
   United Arab Emirates" drops the first four characters (7HQQ) because
   "Dubai" stands for them. Recovering it is the published algorithm
   (github.com/google/open-location-code, recoverNearest): take the reference
   point's own code for the missing prefix, then move one cell of the dropped
   resolution if that puts the result nearer the reference. The reference is
   the emirate the address names, Dubai when it names none — a four-character
   code is a one-degree square, and Abu Dhabi city is 0.75° from Dubai, so one
   reference for every emirate would put an Abu Dhabi code in the sea. */
const OLC = '23456789CFGHJMPQRVWX';
const PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
const REFS = [
  [/abu dhabi/, { lat: 24.45, lng: 54.38 }],
  [/sharjah/, { lat: 25.34, lng: 55.42 }],
  [/ajman/, { lat: 25.41, lng: 55.45 }],
];
export const DUBAI = { lat: 25.2, lng: 55.3 };

/* Bounded by anything that is not a Latin letter or digit, not only by a
   space: Uber's Chinese-locale one-line form runs the code straight on from
   the script — "阿拉伯联合酋长国迪拜酋长国347Q+947". */
const PLUS_RE = /(?<![A-Za-z0-9])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})(?![A-Za-z0-9])/i;

export function findPlusCode(addr) {
  const m = String(addr ?? '').match(PLUS_RE);
  return m ? m[1].toUpperCase() : null;
}

export function plusCodeRef(addr) {
  const s = String(addr ?? '').toLowerCase();
  for (const [re, ref] of REFS) if (re.test(s)) return ref;
  return DUBAI;
}

/* A full code (8+ digits before nothing is missing) to the centre of its
   area, or null when it is not a valid full code. */
export function decodeFull(code) {
  const c = String(code ?? '').toUpperCase();
  const sep = c.indexOf('+');
  if (sep !== 8) return null;
  const digits = c.replace('+', '').replace(/0+$/, '');
  if (digits.length < 8 || [...digits].some((ch) => !OLC.includes(ch))) return null;
  let lat = -90, lng = -180, latRes = 0, lngRes = 0;
  for (let i = 0; i < Math.min(10, digits.length); i += 2) {
    const r = PAIR_RES[i / 2];
    lat += OLC.indexOf(digits[i]) * r;
    lng += OLC.indexOf(digits[i + 1] ?? '2') * r;
    latRes = r; lngRes = r;
  }
  /* Past ten digits each character is a 4-wide, 5-tall grid refinement. */
  for (let i = 10; i < digits.length; i++) {
    latRes /= 5; lngRes /= 4;
    const d = OLC.indexOf(digits[i]);
    lat += Math.floor(d / 4) * latRes;
    lng += (d % 4) * lngRes;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat + latRes / 2, lng: lng + lngRes / 2 };
}

function encodePrefix(lat, lng, len) {
  let la = Math.min(Math.max(lat, -90), 90 - 1e-9) + 90;
  let lo = ((lng + 180) % 360 + 360) % 360;
  let out = '';
  for (let i = 0; out.length < len; i++) {
    const r = PAIR_RES[i];
    const a = Math.floor(la / r), b = Math.floor(lo / r);
    out += OLC[a] + OLC[b];
    la -= a * r; lo -= b * r;
  }
  return out.slice(0, len);
}

/* A short or full code to a position near the reference. */
export function decodePlusCode(code, ref = DUBAI) {
  const c = String(code ?? '').toUpperCase();
  const sep = c.indexOf('+');
  if (sep < 0 || sep > 8 || sep % 2 === 1) return null;
  if (sep === 8) return decodeFull(c);
  const pad = 8 - sep;
  const full = decodeFull(encodePrefix(ref.lat, ref.lng, pad) + c);
  if (!full) return null;
  const res = 20 ** (2 - pad / 2);
  const half = res / 2;
  let { lat, lng } = full;
  if (ref.lat + half < lat && lat - res >= -90) lat -= res;
  else if (ref.lat - half > lat && lat + res <= 90) lat += res;
  if (ref.lng + half < lng) lng -= res;
  else if (ref.lng - half > lng) lng += res;
  return { lat, lng };
}

/* ── 4 and 5. a position, named by a gazetteer ─────────────────────────────
   CELL is imported by src/trip_places.js from src/places.js and handed in
   through cellArea; this module does not retype the grid.

   WHICH gazetteer is the trap this work found. place_cell names a cell in
   FMS's vocabulary — InfoTrack's reverse geocoder, the only source with both
   a fix and an address — and the bookings speak Google's. Measured on 160
   production driver-days (GET /api/driver/day, 9–15 Nov): where a booking has
   both a dash-form address and a tracker fix within 5 minutes, the place_cell
   name equals the address's area on 29.8% of pickups and 24.6% of drop-offs.
   The positions are right; the words are not the same words — "Al Barsha 1"
   for "Al Barsha", "Za'abeel 2" for "Trade Center Second", "Al Garhoud" for
   "Dubai Int'l Airport", "260 Sheikh Zayed Rd" for "Business Bay". Named by
   place_cell alone, the tracker rung would put a second row on the Territory
   list for every place it touched.

   So src/trip_places.js learns a second gazetteer IN THE BOOKINGS' OWN WORDS,
   booking_cell: each drop-off whose address reads by place_area() casts one
   vote for its area in the cell where the car's tracker was at the drop-off
   time (the car is AT the drop-off then). Simulated on the 6,000-booking
   sample — one week, 2,957 votes, 878 cells — the tracker at the request time
   then named the pickup address's own area on 70.3% of pickups (2,594 of
   3,691), against 29.7% through place_cell. cellArea asks booking_cell first
   and place_cell second, and says which one answered (named_by). */

/* How far from the booking's own instant a tracker fix may be and still be
   taken as where the car was. MEASURED on production 2026-11-16 (GET
   /api/track, 89 plates, 8–16 Nov): FMS reports every 6.2 minutes at the
   median (p75 7.0, p90 10.0), CABMAN every 5.0 (p90 52.7 — a parked car
   reports about hourly). The nearest fix to an empty-address Uber request
   was within 3 minutes for 358 of 401, within 5 for 373, within 10 for 379:
   five catches all but six of what ten would, at half the distance a moving
   car can cover. Agreement with the address, where both exist, is in
   docs/COVERAGE.md ("Every pickup and drop-off placed"). */
export const TRACKER_WINDOW_MIN = 5;

/* The words, in one place, for every page and the assistant. The two halves
   are composed because an absent endpoint failed BOTH ways — the text could
   not be read AND no position could be named — and the reason has to say
   both or it is not the true one. */
export const BASIS_TEXT = {
  address: 'from the address',
  address_name: 'named from the address text',
  plus_code: 'from a plus code in the address',
  coordinates: "from the booking's own coordinates",
  tracker: "placed by the car's tracker at the request time",
};
/* The drop-off is placed at the drop-off time, not the request time. */
export const BASIS_TEXT_DROPOFF = { ...BASIS_TEXT, tracker: "placed by the car's tracker at the drop-off time" };
const TEXT_FAIL = {
  no_address: 'no address',
  city_only: 'an address naming only the city',
  other_script: 'an address in a script the matcher does not read',
  unknown_name: 'an address naming no area the fleet knows',
};
const POS_FAIL = {
  no_plate: 'no car to ask a tracker about',
  no_time: 'no time to ask the tracker at',
  cancelled: 'the booking was cancelled before any drop-off',
  scheduled: 'a booking made in advance, so its request time is not when the car was at the pickup',
  no_fix: `no tracker fix within ${TRACKER_WINDOW_MIN} minutes`,
  unnamed_cell: 'a position on ground the fleet has never named',
};
export function reasonText(code) {
  if (!code) return null;
  if (code === 'pending') return 'not placed yet — the resolver has not reached this booking';
  const [t, p] = String(code).split('+');
  const a = TEXT_FAIL[t], b = POS_FAIL[p];
  if (!a || !b) return 'not placed';
  return `${a}, and ${b}`;
}

/* One endpoint up the ladder.
   input:  { addr, lat, lng, plate, at, fix, cancelled }
             fix — the tracker fix chosen for this endpoint, { lat, lng, at,
             minutes, source }, or null; undefined means "not asked yet",
             which is how src/trip_places.js runs the text rungs first and
             asks the database only about endpoints they could not place.
             cancelled — a drop-off with no drop-off time on a cancelled
             booking: there was no drop-off to place, and that, not the
             missing timestamp, is the true reason.
             scheduled — a pickup whose `at` is the moment the booking was
             MADE, on a booking made in advance (review, 2026-11-16). Bolt's
             requested_at is the order's creation (src/sources/bolt_orders.js
             requestedAt = created); on a scheduled ride that precedes the
             pickup by as long as the rider booked ahead — hours — and the
             car's tracker then was wherever the car was, not at the pickup.
             On the sample's 27 Bolt rides that carry a pickup moment
             (ended_at − duration_s), the request preceded it by a median 2.3
             minutes and at most 14.8; a scheduled ride has no such bound. So
             the tracker rung is not asked, and the reason says why.
   ctx:   { vocab, cellArea(lat, lng) → { area, votes, seen, named_by } | null }
   output: { area, basis, reason, detail } — exactly one of area/reason set;
           needsFix: true when only the tracker rung is left to try. */
export function resolveEndpoint(input, ctx) {
  const { addr, lat, lng, plate, at, fix, cancelled, scheduled } = input || {};
  const cellArea = ctx?.cellArea || (() => null);
  let positioned = false;

  const a = placeArea(addr);
  if (a) return { area: a, basis: 'address', reason: null, detail: null };

  const zoned = zoneArea(addr);
  if (zoned) return { area: zoned, basis: 'address_name', reason: null, detail: { matched: zoned, rule: 'zone_code' } };
  const named = matchName(addr, ctx?.vocab);
  if (named) return { area: named, basis: 'address_name', reason: null, detail: { matched: named, rule: 'vocabulary' } };

  const code = findPlusCode(addr);
  if (code) {
    const p = decodePlusCode(code, plusCodeRef(addr));
    if (p) {
      positioned = true;
      const c = cellArea(p.lat, p.lng);
      if (c?.area) {
        return { area: c.area, basis: 'plus_code', reason: null, named_by: c.named_by ?? null,
          detail: { code, lat: round5(p.lat), lng: round5(p.lng), votes: c.votes ?? null, seen: c.seen ?? null } };
      }
    }
  }

  if (isPos(lat, lng)) {
    positioned = true;
    const c = cellArea(Number(lat), Number(lng));
    if (c?.area) {
      return { area: c.area, basis: 'coordinates', reason: null, named_by: c.named_by ?? null,
        detail: { votes: c.votes ?? null, seen: c.seen ?? null } };
    }
  }

  const text = textFailure(addr);
  if (!plate) return absent(text, positioned ? 'unnamed_cell' : 'no_plate');
  if (!at) return absent(text, positioned ? 'unnamed_cell' : cancelled ? 'cancelled' : 'no_time');
  if (scheduled) return absent(text, positioned ? 'unnamed_cell' : 'scheduled');
  if (fix === undefined) return { area: null, basis: null, reason: null, detail: null, needsFix: true };
  if (fix && isPos(fix.lat, fix.lng)) {
    const c = cellArea(Number(fix.lat), Number(fix.lng));
    if (c?.area) {
      return { area: c.area, basis: 'tracker', reason: null, named_by: c.named_by ?? null,
        detail: { fix_at: fix.at ?? null, minutes: fix.minutes ?? null, source: fix.source ?? null,
          votes: c.votes ?? null, seen: c.seen ?? null } };
    }
    return absent(text, 'unnamed_cell');
  }
  return absent(text, positioned ? 'unnamed_cell' : 'no_fix');
}

/* The tracker rung's choice among candidate fixes, so the window and the
   preference are one function the SQL mirrors and the test can pin:
   only fixes within the window; FMS before CABMAN (on the two cars carrying
   both, CABMAN puts the car a median 12.7 and 25.6 km from FMS at the same
   minute and FMS agrees with its own journeys — COVERAGE.md, "on the only two
   cars with both trackers"); then the nearest in time. */
export function chooseFix(fixes, atIso, windowMin = TRACKER_WINDOW_MIN) {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return null;
  let best = null;
  for (const f of fixes || []) {
    const ft = Date.parse(f.at);
    if (!Number.isFinite(ft) || !isPos(f.lat, f.lng)) continue;
    const minutes = Math.abs(ft - t) / 60000;
    if (minutes > windowMin) continue;
    const fms = f.source === 'fms' ? 1 : 0;
    if (!best || fms > best.fms || (fms === best.fms && minutes < best.minutes)) {
      best = { ...f, minutes: Math.round(minutes * 10) / 10, fms };
    }
  }
  if (!best) return null;
  const { fms, ...out } = best;
  return out;
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;
/* A tracker reporting 0,0 on boot is the common bad fix (api/telemetry_sql.js
   REAL_FIX); the UAE box is src/places.js IN_UAE. */
function isPos(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return lat != null && lng != null && Number.isFinite(a) && Number.isFinite(b)
    && a > 22 && a < 27 && b > 51 && b < 57;
}
function absent(text, pos) {
  return { area: null, basis: null, reason: `${text}+${pos}`, detail: null };
}
