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
