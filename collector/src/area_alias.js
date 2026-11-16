/* One area, one name (FIX-STATUS PLC12, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   After PLC placed every booking, the operator's Territory tab still split one
   place across rows: "Jumeirah Lakes Towers" 13, "Jumeirah Lake Towers" 7,
   "JLT Cluster J" 5. Measured on production over the 60 busiest drivers'
   pickups and drop-offs, 17 Oct – 16 Nov (GET /api/driver/territory):

     Marsa Dubai 1,854 · Dubai Marina 100 · دبي مارينا 5
     Nakhlat Jumeira 1,181 · Palm Jumeirah 55 · The Palm Jumeirah 11 · نخلة جميرا 9
     Business Bay 3,022 · الخليج التجاري 97 · Бизнес-Бэй 3 · İş Körfezi 2 · Bay Square 3
     Downtown Dubai 2,559 · Burj Khalifa 30 · وسط مدينة دبي 21 · Даунтаун Дубай 3 · Downtown Burj Khalifa 3
     Jumeirah Village Circle 611 · قرية جميرا الدائرية 27 · JVC 4
     Hadaeq Sheikh Mohammed Bin Rashid 575 · Dubai Hills 27 · حدائق الشيخ محمد بن راشد 4
     … and a dozen more pairs below.

   Two causes, both upstream: Google's dash-form address names a community by
   its official name ("Marsa Dubai", "Nakhlat Jumeira") where the rider's own
   text says the common one, and Uber writes the address in the RIDER's app
   language — Arabic, Russian, Turkish — so one area arrives in four scripts.

   THE RULE: only exact equivalents are folded — the same community under its
   official name, its common name, an abbreviation, or a translation of it.
   A sub-area is NOT folded into its parent ("Jumeirah 1" stays apart from
   "Jumeirah"; "Al Barsha South" from "Al Barsha"; the two airports apart),
   because that would be a coarser claim than the address made. The exceptions
   are named clusters that ARE the community in every sense a pickup cares
   about ("JLT Cluster J", "China Cluster" of International City), and a
   landmark that names its own community ("Burj Khalifa", "Bay Square").
   Canonical names are the common English ones a dispatcher says.

   Applied at READ time (api/trip_place_sql.js), so every row already resolved
   is folded the moment this deploys, with no re-resolve and no migration; the
   stored area stays what the evidence said. A name not in the list passes
   through untouched — nothing is guessed. */

const GROUPS = [
  ['Dubai Marina', ['marsa dubai', 'dubai marina', 'دبي مارينا', 'дубай марина']],
  ['Palm Jumeirah', ['nakhlat jumeira', 'nakhlat jumeirah', 'palm jumeirah', 'the palm jumeirah', 'the palm', 'نخلة جميرا']],
  ['Jumeirah Lakes Towers', ['jumeirah lakes towers', 'jumeirah lake towers', 'jlt', 'أبراج بحيرات جميرا']],
  ['Jumeirah Village Circle', ['jumeirah village circle', 'jvc', 'قرية جميرا الدائرية']],
  ['Jumeirah Village Triangle', ['jumeirah village triangle', 'jvt', 'قرية جميرا المثلثة']],
  ['Downtown Dubai', ['downtown dubai', 'downtown burj khalifa', 'burj khalifa', 'وسط مدينة دبي', 'даунтаун дубай']],
  ['Business Bay', ['business bay', 'bay square', 'الخليج التجاري', 'бизнес-бэй', 'бизнес бэй', 'iş körfezi']],
  ['Deira', ['deira', 'ديرة']],
  ['Al Garhoud', ['al garhoud', 'garhoud', 'القرهود']],
  ['Al Quoz', ['al quoz', 'القوز']],
  ['Al Barsha', ['al barsha', 'البرشاء']],
  ['Al Wasl', ['al wasl', 'الوصل']],
  ['Jumeirah', ['jumeirah', 'جميرا']],
  ['Jumeirah 1', ['jumeirah 1', 'jumeirahjumeirah 1']],
  ['Trade Center First', ['trade center first', 'المركز التجاري الأولي']],
  ['Dubai Hills Estate', ['dubai hills estate', 'dubai hills', 'hadaeq sheikh mohammed bin rashid', 'حدائق الشيخ محمد بن راشد']],
  ['Jumeirah Beach Residence', ['jumeirah beach residence', 'jbr', 'مساكن شاطئ جميرا']],
  ['Dubai International City', ['dubai international city', 'international city', 'china cluster', 'مدينة دبي العالمية']],
  ['Green Community Village', ['green community village', 'قرية المجتمع الخضراء']],
  ['Dubai Festival City', ['dubai festival city', 'مدينة مهرجان دبي']],
  ["Za'abeel 2", ["za'abeel 2", "zaa'beel second", "za'abeel second"]],
  ['DAMAC Hills', ['damac hills']],
  ['Dubai International Airport', ['dubai international airport', "dubai int'l airport", 'dxb']],
];

/* Prefix rules: every "JLT Cluster X" is in JLT. Kept separate from the
   exact list so a reader can see which folds are patterns. */
const PREFIXES = [['jlt cluster ', 'Jumeirah Lakes Towers']];

export const AREA_ALIAS = Object.freeze(Object.fromEntries(
  GROUPS.flatMap(([canon, names]) => names.map((n) => [n, canon]))));

/* The Turkish dotted capital İ lower-cases to "i" plus a combining dot in
   JavaScript, and to whatever the database's collation says in SQL — so the
   two twins could disagree on "İş Körfezi". It is mapped to a plain "i"
   first, on both sides, so the key is the same everywhere. */
const key = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/İ/g, 'i').toLowerCase();

/* The JS twin, for code that names an area outside SQL (and for the tests,
   which hold the SQL against it). */
export function canonArea(name) {
  if (name == null) return name;
  const k = key(name);
  if (!k) return name;
  if (AREA_ALIAS[k]) return AREA_ALIAS[k];
  for (const [p, canon] of PREFIXES) if (k.startsWith(p)) return canon;
  return String(name).trim();
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* The SQL: one CASE over the trimmed, lower-cased, space-folded name. A
   NULL stays NULL (an unplaced endpoint keeps its reason). */
export function canonAreaSql(expr) {
  const k = `lower(translate(regexp_replace(btrim(${expr}), '\\s+', ' ', 'g'), 'İ', 'i'))`;
  const whens = Object.entries(AREA_ALIAS).map(([a, c]) => `WHEN ${lit(a)} THEN ${lit(c)}`).join(' ');
  const pre = PREFIXES.map(([p, c]) => `WHEN ${k} LIKE ${lit(`${p}%`)} THEN ${lit(c)}`).join(' ');
  return `(CASE WHEN ${expr} IS NULL THEN NULL ${pre} ELSE (CASE ${k} ${whens} ELSE btrim(${expr}) END) END)`;
}
