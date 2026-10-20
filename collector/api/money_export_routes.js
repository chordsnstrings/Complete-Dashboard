/* GET /api/export/money.xlsx — the money workbook, as a file.
   ═════════════════════════════════════════════════════════════════════════
   The sheets and every rule behind them are api/money_workbook.js; this file
   decides who asked for what, and hands back bytes.

     ?from=&to=  (or period=/days=, as every page sends them) the Dubai days
     ?fleet=     ecosine | egari, or both when absent
     ?platform=  uber | bolt | yango | hotel, or all when absent
     ?person=p12 one driver's file; ?account=<id> one account no person holds

   ANYONE MAY DOWNLOAD IT — the operator, 2026-09-28: "anyone since it's
   operations". While sign-in is optional that is literally anyone; once it is
   required, the route manifest opens it to a role that holds cash, and a
   signed-in reader's file carries "(withheld)" in every column of a class
   their role does not hold in full — the rule the trip CSV follows
   (api/server.js EXPORT_CLASS_COLS), because the access layer shapes JSON and
   never sees the inside of a file.

   NEVER KEPT. `private, no-store`: it names drivers, their mobiles and the
   cash each holds, and a shared proxy or the next person at the machine must
   not be handed it from a cache. The API's response cache never stores it —
   it goes out with res.end, not res.json. */
import { buildMoneyWorkbook, MAX_DAYS } from './money_workbook.js';
import { personParam, loadDirectory, driverScope } from './driver_routes.js';

const PLATFORMS = ['uber', 'bolt', 'yango', 'hotel'];
const FLEETS = ['ecosine', 'egari'];
/* The classes the workbook's columns carry. A signed-in reader whose role
   holds one of these below F gets it withheld. */
/* EARN since 2026-10-20: the Drivers sheet now carries the Drivers page's
   Money and Paid columns, which the page guards as EARN, so a role the page
   withholds them from finds them withheld here too. */
const FILE_CLASSES = ['ID', 'CT', 'CASH', 'REV', 'PAY', 'VEH', 'EARN'];

export function moneyExportRoutes(app, { q, wrap, winDays, log = null }) {
  app.get('/api/export/money.xlsx', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const [from, to] = winDays(req);
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;
    if (!(days >= 1) || days > MAX_DAYS) {
      return res.status(413).json({ error: 'range too long for one workbook', from, to, days, limit: MAX_DAYS,
        detail: `This workbook is built for up to ${MAX_DAYS} days and ${from} to ${to} is ${days}. `
          + 'Choose a shorter range, or use the trip CSV for every booking over any length.' });
    }
    const fleet = FLEETS.includes(String(req.query.fleet)) ? String(req.query.fleet) : null;
    const platform = PLATFORMS.includes(String(req.query.platform)) ? String(req.query.platform) : null;

    let person = null;
    const pid = personParam(req);
    if (Number.isNaN(pid)) {
      return res.status(400).json({ error: 'not a person id', detail: 'person= takes p412 or 412.' });
    }
    if (pid != null) {
      const [d] = await q(`SELECT id, full_name FROM driver WHERE id = $1`, [pid]);
      if (!d) return res.status(404).json({ error: 'no such driver', detail: 'No person on the register carries that id.' });
      /* The name the driver's own page prints in its header — the identity
         register's, then a confirmed link's, then their account's — not the
         person record's, which differed for 57 of 115 drivers on 1-20
         October 2026 (docs/FIXLIST-2026-09-05.md DR1). Resolved exactly as
         /api/driver/profile resolves #driver/p<id>. */
      const shown = await driverScope({ q, wrap }).resolve({ query: { person: String(pid) } }).catch(() => null);
      person = { id: pid, name: shown?.name || d.full_name };
    } else if (req.query.account) {
      const account = String(req.query.account).trim().slice(0, 200);
      const [seen] = await q(`SELECT 1 AS ok FROM trip WHERE driver_ext_id = $1 LIMIT 1`, [account]);
      if (!seen) return res.status(404).json({ error: 'no such driver', detail: 'No driver in this fleet holds that platform account.' });
      person = { account };
    }

    const levels = req.fm?.kind === 'user' || req.fm?.kind === 'device' ? (req.fm.levels || {}) : null;
    const hide = new Set(levels ? FILE_CLASSES.filter((c) => levels[c] !== 'F') : []);

    const t0 = Date.now();
    /* The Drivers page's own rows for the same dates and chips — the sheet
       of that name is built from them (api/money_workbook.js). */
    const directory = await loadDirectory(q, { from, to, platform, fleet });
    const { wb, totals } = await buildMoneyWorkbook({ q, from, to, fleet, platform, person, directory, hide });
    const buf = wb.toBuffer();
    const who = person ? `-${String(person.name || person.account).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}` : '';
    const name = `cash-and-money-${from}-to-${to}${fleet ? `-${fleet}` : ''}${platform ? `-${platform}` : ''}${who}.xlsx`;
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('content-length', String(buf.length));
    /* What the file covers, readable without opening it. */
    res.setHeader('x-export-window', `${from}..${to}`);
    res.setHeader('x-export-drivers', String(totals.people));
    if (hide.size) res.setHeader('x-export-withheld', [...hide].join(','));
    log?.info?.('api', 'money workbook', { days, fleet, platform, one: !!person, bytes: buf.length, ms: Date.now() - t0 });
    return res.end(buf);
  }));
}
