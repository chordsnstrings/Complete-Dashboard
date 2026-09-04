/* The Yango performance mapping, exercised without a network or a database.
   ─────────────────────────────────────────────────────────────────────────
   pullPerformance is not exported and reaching it would mean standing up an
   HTTP fixture for a park this fleet is not currently entitled to. The
   mapping itself is a pure expression over one item, so it is lifted out of
   the source by its own text and evaluated — which also means a rewrite of
   that expression cannot pass this file by accident. */
import { readFileSync } from 'node:fs';

export async function rowsFromPerformance() {
  const src = readFileSync('src/sources/yango.js', 'utf8');
  const m = src.match(/earnings: \(Number\(it\.price_cash\)[\s\S]*?cash_earnings: it\.price_cash,/);
  if (!m) throw new Error('the Yango earnings mapping is no longer where this test reads it');
  const expr = m[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*$/, '');
  // eslint-disable-next-line no-new-func
  const build = new Function('it', `return { ${expr} };`);
  const worked = (r, it) => (it.count_orders_completed > 0 || (r.earnings || 0) > 0
    || (it.work_time_seconds || 0) > 0);
  return (it) => {
    const r = build(it);
    return worked(r, it) ? r : null;
  };
}
