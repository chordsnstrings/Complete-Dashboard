/* One spelling for a channel, on the server side.
   ──────────────────────────────────────────────────────────────────────────
   This map existed three times — api/roster_routes.js:4, src/insights.js:103
   and, for the browser, api/public/ui.js's SOURCE_LABEL — and api/
   online_routes.js needed it a fourth time to say "this driver worked Hotel"
   in a sentence an operations person reads.

   It matters more than tidiness. api/online_routes.js's own header records
   what happens when a database key reaches a reader: production printed
   `onboarding_status_waitlisted_auto_reactivation` at somebody deciding who to
   phone, and ui.js's SOURCE_LABEL carries the same note about `fms` and
   `cabman` being rendered raw as panel headings. A map that exists three times
   is a map where one copy is missing the channel that was added last.

   The browser copy stays where it is: api/public/ is served as plain ESM
   straight to the page and cannot import from src/. It is the one to check
   against when a channel is added. */
export const CHANNEL_NAMES = {
  uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel',
  fms: 'FMS telematics', cabman: 'CABMAN',
};

/* Unknown keys fall through to themselves rather than to "unknown": a channel
   nobody has added here should read as its own name, which is odd enough to be
   reported, not as a word that hides which channel it was. */
export const channelLabel = (v) => CHANNEL_NAMES[String(v || '').toLowerCase()] || String(v || '');

/* A list of them, in the words the sentence needs: "Hotel and Bolt". */
export const channelWords = (list) => (list || []).map(channelLabel).join(' and ');
