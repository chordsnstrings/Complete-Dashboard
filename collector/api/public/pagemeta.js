/* WHAT THE SHELL KNOWS ABOUT A PAGE BEFORE THE PAGE HAS LOADED.
   ─────────────────────────────────────────────────────────────────────────
   Pages load when they are opened (app.js PAGE_OF, 2026-10-27, FIX-STATUS
   LAZY). The header is drawn before the page is: it names the tab a detail
   page is on (#driver/<id>/earnings → "Earnings"), checks that a week in the
   address is a Monday, and points the Excel button at the month's workbook.
   Those few facts lived in the page modules, which kept driver.js (300 KB),
   vehicle.js, corporate.js, economics.js, performers.js and targetmonth.js
   in every first screen just so the header could read a list of tab names.
   They live here now, moved verbatim with their reasons; the page modules
   import them from here too, so there is still one copy of each. Nothing in
   this file may import a page module. */

/* `day` is deliberately NOT in this list. It is a destination reached by
   clicking a bar on Activity, not a seventh tab somebody picks cold — a tab
   labelled "Day" with no day chosen has nothing to show. */
export const DRIVER_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'activity', label: 'Activity', ic: '◷' },
  { id: 'territory', label: 'Territory', ic: '◍' },
  { id: 'earnings', label: 'Earnings', ic: '◈' },
  { id: 'quality', label: 'Quality', ic: '△' },
  /* Between Quality and Trips deliberately. Record is a reading of the same
     person over time rather than a new subject, so it sits after the panels
     that describe them and before the raw rows that evidence them. */
  { id: 'record', label: 'Record', ic: '◲' },
  /* AFTER RECORD AND BEFORE TRIPS. Money is a reading of this person, like
     Record, rather than a new subject — and it is read against what the tabs
     before it say they earned. It sits ahead of Trips for the same reason
     Record does: the raw rows evidence the readings, they are not one. */
  { id: 'money', label: 'Money', ic: '⊛' },
  { id: 'trips', label: 'Trips', ic: '▤' },
  /* LAST, and after Trips deliberately. Every tab before this one is built
     from records that NAME this person — a booking carries a driver id and the
     row is a fact. This one is built from journeys no booking explains, so
     every name on it is an inference drawn from the time and the custody
     record. It sits at the end because it is read after the record, against
     the record.

     Labelled "Unexplained trips" and not "Unauthorized": api/public/app.js
     setHeader() prints `${tab.label} — every platform this person works on,
     combined` as the page subtitle, and a label of "Unauthorized" makes that
     sentence read as a verdict on the PERSON rather than on the journeys. The
     journeys are unexplained; nobody on this page has been found to have done
     anything. */
  { id: 'unauthorized', label: 'Unexplained trips', ic: '◌' },
];

export const VEHICLE_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'drivers', label: 'Drivers', ic: '◧' },
  { id: 'movement', label: 'Movement', ic: '◍' },
  { id: 'earnings', label: 'Earnings', ic: '◈' },
  { id: 'safety', label: 'Safety', ic: '△' },
  { id: 'compliance', label: 'Compliance', ic: '❑' },
  { id: 'trips', label: 'Trips', ic: '▤' },
];

export const PROPERTY_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'guests', label: 'Passengers', ic: '◧' },
  { id: 'drivers', label: 'Drivers', ic: '◨' },
];

export const UNIT_TABS = [
  { id: 'overview', label: 'Money in', ic: '◆' },
  { id: 'assets', label: 'Every vehicle', ic: '▤' },
  { id: 'drivers', label: 'Every driver', ic: '◧' },
];

/* The week rides in the address — `#top-performers/<monday>` and
   `#performer/<id>/<monday>` — so a ranking of March can be linked, opened in
   a tab, and drilled into without snapping back to the current week. Only a
   MONDAY is honoured: the server treats whatever it is given as a week start,
   so a hand-typed Wednesday would rank a seven-day window aligned to nothing
   while every caption on the page still said "Monday to Sunday". */
export const isWeek = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '')
  && new Date(`${v}T12:00:00Z`).getUTCDay() === 1;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m) => MONTH_RE.test(String(m || ''));

/** The workbook of the month on screen. */
export const workbookUrl = (month = null) => `/api/export/target-month.xlsx${isMonth(month) ? `?month=${month}` : ''}`;

/* THE PAGE CONTRACT'S TOKEN, and the house principle.
   ─────────────────────────────────────────────────────────────────────────
   Which DOM a page builds — the page contract (docs/UI-REDESIGN-PLAN.md §3:
   00 AT A GLANCE → 01 the hero → the supporting marks → † what this page
   does not know → the footer with the principle line) or the old page — is
   the other thing the shell knows about a page before it loads, and it is
   asked of a token, never of the skin attribute: app.css declares
   --pg-contract:0 for the old skin, arkiv.css 1 (test/arkiv_skin.test.mjs
   holds every module to that). No stylesheet — a test harness, a detached
   document, node — answers the old skin, which is what a page draws when it
   cannot tell.

   It lived in ui.js, which 56 of the 84 front-end modules import it from
   (ui.js re-exports it from here, unchanged). The sign-in page could not ask
   it: signin.html is its own document and loads no module of the dashboard
   on purpose — ui.js pulls in charts.js, data.js and tokens.js, about 350 KB
   a person who has not signed in has no use for — so it printed none of the
   contract, not even the principle line every other page carries (HANDOFF
   §4.5, "page-contract branches for … sign-in"). Here, in a module that
   imports nothing and is already on every first screen, it costs the
   sign-in page 5 KB and the first screen no extra module (test/
   lazy_pages.test.mjs counts them). signin.html declares --pg-contract:1
   itself, because it always draws the Arkiv look. */
export function contract() {
  try {
    return String(getComputedStyle(document.documentElement).getPropertyValue('--pg-contract')).trim() === '1';
  } catch { return false; }
}

/* The house principle, verbatim. index.html prints it in the shell footer;
   ui.js pageFoot() and the sign-in page's footer print this constant. */
export const PRINCIPLE = 'A figure that cannot be measured is shown absent, with the reason — never as zero.';
