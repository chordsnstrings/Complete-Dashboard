/* WHAT THE TRACKER ROSTER SET ASIDE, as a page prints it (FIXLIST C18).
   ─────────────────────────────────────────────────────────────────────────
   GET /api/fleet/roster   the exclusion note — anyone holding vehicles

   /api/live and /api/vehicles/directory now leave out (or flag) the CABMAN
   plates the collector's roster says the provider has stopped listing. Both
   are BARE ARRAYS, and that shape is load-bearing: the access manifest shapes
   them by path ('[].lat' withheld from a role without locations) and narrows
   their rows by '[]'.fleet_id for a one-fleet reader. Wrapping either in an
   object to carry a sentence would have handed every role every position and
   every fleet every row. So the sentence lives here, one cheap read of one
   source_state row (cached a minute in api/fleet_roster.js), and #live, #map
   and #vehicles read it beside the array they draw.

   What it answers: `n` and `held` (the plates set aside), `known` and `state`
   (whether a roster exists to have set anything aside, and if not, why not —
   no roster yet, an unreadable one, or a read that failed), `reason` (the
   sentence for a figure that dropped `n` plates), `why` (the same reason with
   no count, for a page that counts its own flagged rows), the plates
   themselves capped at 200, and each fleet's poll count and last update.

   ?fleet= narrows to one fleet's roster. The manifest declares the route
   'param', so a reader limited to one fleet is answered for that fleet only
   and never sees the other fleet's plates. A fleet that does not exist is a
   400 rather than "the roster has not been written yet": that sentence would
   be a reason, and it would not be the true one. */
import { fleetRoster, rosterFor, exclusionNote } from './fleet_roster.js';

export function fleetRosterRoutes(app, { q, wrap }) {
  app.get('/api/fleet/roster', wrap(async (req, res) => {
    const fleet = req.query.fleet ? String(req.query.fleet) : null;
    if (fleet) {
      const [known] = await q('SELECT 1 AS ok FROM fleet WHERE id = $1', [fleet]);
      if (!known) return res.status(400).json({ error: 'bad_fleet', detail: `There is no fleet called ${fleet}.` });
    }
    const roster = rosterFor(await fleetRoster(q), fleet);
    res.json({
      fleet,
      ...exclusionNote(roster),
      departed: roster.departed.size,
      pending: roster.pending.size,
      listed: roster.listed.size,
      fleets: roster.fleets,
    });
  }));
}
