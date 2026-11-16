/* WHICH ADDRESS IS THE AIRPORT — api/airport_sql.js, its SQL and its JS twin.
   ═════════════════════════════════════════════════════════════════════════
   Every address below is a real string from production's bookings
   (/api/trips/list, 17 Oct – 15 Nov 2026, read 2026-11-16), copied as it
   came. The commonest "airport" address of all, "Airport Rd - Al Garhoud",
   is a road of warehouses and hotels and is NOT the airport; "Dubai Int…"
   is also Internet City, International City, the Marine Club, a dozen
   schools; "DXB" and "DWC" alone are codes inside other things; Google files
   the Free Zone's offices under "Dubai Int'l Airport". Each is held here, and
   each is run through BOTH engines — JS (airportOfAddress) and Postgres on
   PGlite (airportOfSql) — which must agree on every one: two copies of a
   rule that disagree are two different airports.

   REVERSIONS (each made on 2026-11-16, each failed the checks named):
     · the SQL builder without the \b → \y conversion → every "SQL and JS
       agree" check on a word-bounded pattern (Postgres reads \b as a
       backspace, so "(DXB)"-free terminal addresses and every exclusion
       built on \b stop matching).
     · NOT_AIRPORT without 'free\\s*zone' → "the Free Zone offices are not
       the airport" (JS and SQL alike).
     · DXB without its bracket rule, '\\(dxb\\)' → "the hotel channel's and
       every language's (DXB)".
     · TERMINAL accepted without an airport word → "a bus or taxi terminal
       is not the airport". */
import { PGlite } from '@electric-sql/pglite';
import { airportOfAddress, airportOfSql, AIRPORT_PATTERNS } from '../api/airport_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* [address, expected], grouped by the reason it is here. */
const CASES = {
  'Dubai International’s terminals, as Google writes them': [
    ["Terminal 3 - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Terminal 1 - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Terminal 2 - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Dubai - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Arrival Hall, Terminal 3 - 2533 - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["T2 Parking Exit - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["69X2+7XF DXB Terminal 1 Car Park A2 - Dubai Int'l Airport - Dubai - United Arab Emirates", 'OMDB'],
    ["Дубай - Dubai Int'l Airport - Дубай - Объединенные Арабские Эмираты", 'OMDB'],
    ['Dubai International Airport, Concourse B, Terminal 3 - Dubai Int\'l Airport - Dubai - 阿拉伯联合酋长国', 'OMDB'],
    ["Launchpad Dubai Int'L Airport Dubai Int'L Airport AE", 'OMDB'],
  ],
  'the hotel channel’s and every language’s (DXB)': [
    ['Terminal 1, Dubai International Airport (DXB) - Al Garhoud - DU - AE', 'OMDB'],
    ['Terminal 3, Dubai Airport (DXB)', 'OMDB'],
    ['Terminal 1, Flughafen Dubai (DXB)', 'OMDB'],
    ['Terminal 1, Aéroport de Dubaï (DXB)', 'OMDB'],
    ['مبنى 3, مطار دبي (DXB)', 'OMDB'],
  ],
  'a terminal named with the word airport, or as a place inside one': [
    ['Airport Terminal 3 AE', 'OMDB'],
    ['Terminal 1 Airport Road Garhoud AE', 'OMDB'],
    ['Terminal 3 Meeting Point- After Customs, at Exit 2 (inside the terminal) AE', 'OMDB'],
    ['Dubai International Airport Terminal 3 - Terminal 3 - T3 - مطار دبي الدولي - دبي - United Arab Emirates', 'OMDB'],
  ],
  'Al Maktoum International (DWC)': [
    ['Madinat Al Mataar - AL Maktoum International Airport (DWC) - Dubai - United Arab Emirates', 'OMDW'],
    ['Sector 5, Al Maktoum International Airport, Departure Zone', 'OMDW'],
    ['Al Maktoum International Air - Madinat Al Mataar - Dubai South - Dubai - United Arab Emirates', 'OMDW'],
    ['Al Maktoum Airport - Madinat Al Mataar - Dubai South - Dubai - Émirats arabes unis', 'OMDW'],
    ['DWC Private Jets Terminal - مدينة المطار - دبي الجنوب - دبي - United Arab Emirates', 'OMDW'],
  ],
  '“Airport Rd – Al Garhoud” and its hotels are not the airport': [
    ['Airport Rd - Al Garhoud - Dubai - United Arab Emirates', null],
    ['Airport Rd - Al Garhoud - Dubai - Объединенные Арабские Эмираты', null],
    ['24 Airport Rd - Al Garhoud - Dubai - United Arab Emirates', null],
    ['Le Meridien Dubai Airport Road Garhoud AE', null],
    ['Flora Inn Hotel Dubai Airport - 24 Airport Rd - Al Garhoud - Dubai - United Arab Emirates', null],
    ['Le Méridien Dubai Hotel & Conference Centre - Airport Rd - Al Garhoud - Dubai - United Arab Emirates', null],
    ['Airport View Building - Al Garhoud - Dubai - United Arab Emirates', null],
    ['شارع المطار - القرهود - دبي - الإمارات العربية المتحدة', null],
  ],
  '“Dubai Int…” that is not the airport': [
    ['Al Awir Rd - Warsan First - Dubai International City - Dubai - United Arab Emirates', null],
    ['DXB30 Al Falak Street Dubai Internet City AE', null],
    ['Marsa Dubai - Dubai International Marine Club - Dubai - United Arab Emirates', null],
    ['Dubai International Academy Al Barsha Al Barsha First Al Barsha First AE', null],
    ['Gate Village - Dubai International Financial Centre - Dubai', null],
    ['Dubai International Academic City - Dubai - United Arab Emirates', null],
    ['Dubai International School Casablanca Street Al Garhoud AE', null],
  ],
  'the Free Zone offices are not the airport': [
    ["155 Al Quds St - Dubai Int'l Airport - Dubai Airport Free Zone - Dubai - United Arab Emirates", null],
    ["DAFZA, Block A701 ,West wing 5 - Dubai Int'l Airport - Dubai Airport Free Zone - Dubai - United Arab Emirates", null],
    ['8W Building, Dubai Airport Freezone - 214 Al Quds Street 214 Al Quds Street DAFZA AE', null],
    ["143 Al Quds St - Dubai Int'l Airport - Dubai - United Arab Emirates", null],
    ["Dubai Int'l Airport - Dubai Airport Free Zone - Dubai - United Arab Emirates", null],
    ["Arena FZE - Building 5EA Office G-20 - Dubai Int'l Airport - Dubai Airport Free Zone - Dubai - United Arab Emirates", null],
  ],
  '“opposite”, “oppo” and “near” the airport are not the airport': [
    ['Garhoud Area - opposite to Airport Terminal 3 - Al Garhoud - Dubai - United Arab Emirates', null],
    ['Emirates Group Headquarters, opposite to Airport Terminal 3 - Dubai - United Arab Emirates', null],
    ["Oppo Dubai Int'L Airport Terminal 3 - أم رمول - دبي - United Arab Emirates", null],
    ['Street 13, Al Ramool - near to Dubai International Airport - المنطقة الصناعية - Dubai', null],
    ["Al Ittihad Rd - Dubai Int'l Airport - E11 - Dubai - 阿拉伯联合酋长国", null],
  ],
  '“DXB” and “DWC” as codes inside other things': [
    ['AE-DXB-YTS - Al Hebiah Second - Dubai Studio City - Dubai - United Arab Emirates', null],
    ['DXB5 E-Fulfiment Centre 4 World Central - EZDubai - مدينة المطار - دبي الجنوب - دبي - United Arab Emirates', null],
    ['Boho Salon. DXB, Dubai - United Arab Emirates', null],
    ['Dubai Logistics City Dubai Logistics City DWC, Building A2, Office #207 - مدينة المطار - Dubai South Business Park', null],
  ],
  'other airports, and roads named after them': [
    ['Terminal A - Al Matar - Zayed International Airport - Abu Dhabi - United Arab Emirates', null],
    ['Sharjah International Airport, Sharjah - United Arab Emirates', null],
    ['Sharjah Intl. Airport, Al Ruqa Al Hamra, Sharjah', null],
    ['Al Maktoum Rd - Al Muraqqabat - Deira - Dubai - United Arab Emirates', null],
    ['Sobha Hartland - Mohammed Bin Rashid Al Maktoum City - Al Merkadh - Nad Al Sheba - Dubai - United Arab Emirates', null],
  ],
  'a bus or taxi terminal is not the airport': [
    ['Al Safa Street Taxi Terminal, City Walk Mall', null],
    ['Terminal 1 Bus Station - Al Ghubaiba - Bur Dubai', null],
  ],
  'nothing at all': [[null, null], ['', null], ['   ', null]],
};

const db = new PGlite();
const all = Object.values(CASES).flat();
const values = all.map((_, i) => `($${i + 1}::text, ${i})`).join(', ');
const sqlRows = (await db.query(`SELECT i, ${airportOfSql('a')} AS ap FROM (VALUES ${values}) AS t(a, i) ORDER BY i`,
  all.map(([a]) => a))).rows;
const sqlOf = new Map(sqlRows.map((r) => [r.i, r.ap]));

let idx = 0;
for (const [group, cases] of Object.entries(CASES)) {
  console.log(`\n${group}`);
  const jsBad = [], sqlBad = [];
  for (const [addr, want] of cases) {
    const js = airportOfAddress(addr);
    const sq = sqlOf.get(idx++) ?? null;
    if (js !== want) jsBad.push(`${JSON.stringify(addr)} → ${js}`);
    if (sq !== want) sqlBad.push(`${JSON.stringify(addr)} → ${sq}`);
  }
  check(`JS: ${cases.length} ${cases.length === 1 ? 'address' : 'addresses'} as expected`, jsBad.length === 0, jsBad.join(' | '));
  check('SQL and JS agree, and are right', sqlBad.length === 0, sqlBad.join(' | '));
}

console.log('\nthe SQL is Postgres’s dialect');
const sqlText = airportOfSql('x');
check('no \\b reaches Postgres (it is a backspace there); word bounds are \\y', !/\\b/.test(sqlText) && /\\y/.test(sqlText));
check('no apostrophe inside a pattern (the SQL literal needs no escaping)', !Object.values(AIRPORT_PATTERNS).some((p) => p.includes("'")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
