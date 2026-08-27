/* ── the second silent no-op of the session ────────────────────────────────
   foldRows read `node.tBodies`, and tableFrom returns a `div.tscroll` WRAPPING
   the table rather than the table itself. So it found no rows, returned early,
   and the drivers page stayed 44,625 pixels tall with no error anywhere — it
   rendered, it looked right, it did nothing. The same shape as the verdict bug
   an hour earlier: a feature that appears to work because failure and success
   look identical from outside.

   Both failures share a cause — code that reads a field off a structure it
   never checked. So this asserts the OUTCOME (how many rows a reader can see)
   rather than the mechanism, and does it through the wrapper the app really
   passes.

   A hand-rolled DOM, because the assertion is about counting rows and toggling
   a flag, not about layout — and pulling in jsdom for that would be a
   dependency the whole suite carries for one file. */
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

class Node {
  constructor(tag, cls) {
    this.tagName = String(tag).toUpperCase();
    this.className = cls || '';
    this.children = []; this.hidden = false; this.textContent = '';
    this.attrs = {}; this.style = { setProperty() {} };
    this.classList = {
      _s: new Set(cls ? cls.split(' ') : []),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  append(...n) { this.children.push(...n); return this; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(ev, fn) { (this._on ||= {})[ev] = fn; }
  click() { this._on?.click?.(); }
  querySelector(sel) {
    const want = sel.toUpperCase();
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tagName === want) return c;
        const hit = walk(c); if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  get innerHTML() { return ''; }
  set innerHTML(_) { /* not needed here */ }
}
globalThis.document = { createElement: (t) => new Node(t) };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
};

const { foldRows } = await import('../api/public/ui.js');

/* Exactly what tableFrom builds: a wrapper div, a table inside it. */
const makeTable = (n) => {
  const wrap = new Node('div', 'tscroll');
  const table = new Node('table');
  const body = new Node('tbody');
  const rows = Array.from({ length: n }, () => new Node('tr'));
  body.append(...rows);
  table.append(body);
  table.tBodies = [{ rows }];
  wrap.append(table);
  return { wrap, rows };
};
const visible = (rows) => rows.filter((r) => !r.hidden).length;

/* ── the bug ─────────────────────────────────────────────────────────────── */
{
  const host = new Node('div');
  const { wrap, rows } = makeTable(361);
  foldRows(host, wrap, { shown: 12, total: 361, noun: 'driver', key: null });
  check('a table inside tableFrom’s wrapper is found and folded',
    visible(rows) === 12, `${visible(rows)} visible of ${rows.length}`);
  const btn = host.children.find((c) => c.tagName === 'BUTTON');
  check('and the control says how many rows it is holding back',
    btn && /349/.test(btn.textContent) && /driver/.test(btn.textContent), btn?.textContent);
  btn.click();
  check('opening it shows every row — folded, never truncated',
    visible(rows) === 361, `${visible(rows)} visible`);
  btn.click();
  check('and it folds again', visible(rows) === 12, `${visible(rows)} visible`);
}
/* ── a bare table still works, since callers may pass either ─────────────── */
{
  const host = new Node('div');
  const { wrap, rows } = makeTable(50);
  const table = wrap.querySelector('table');
  foldRows(host, table, { shown: 5, total: 50 });
  check('a bare table is folded too', visible(rows) === 5, String(visible(rows)));
}
/* ── nothing to fold ─────────────────────────────────────────────────────── */
{
  const host = new Node('div');
  const { wrap, rows } = makeTable(8);
  foldRows(host, wrap, { shown: 12, total: 8 });
  check('a short table gets no control and hides nothing',
    visible(rows) === 8 && !host.children.some((c) => c.tagName === 'BUTTON'), String(visible(rows)));
}
/* ── the preference is remembered ────────────────────────────────────────── */
{
  const host = new Node('div');
  const a = makeTable(40);
  foldRows(host, a.wrap, { shown: 10, total: 40, key: 'k1' });
  host.children.find((c) => c.tagName === 'BUTTON').click();     // open it
  const host2 = new Node('div');
  const b = makeTable(40);
  foldRows(host2, b.wrap, { shown: 10, total: 40, key: 'k1' });
  check('a reader who opened the long form gets it next time',
    visible(b.rows) === 40, `${visible(b.rows)} visible`);
}
/* ── and the no-op is loud now ───────────────────────────────────────────── */
{
  const host = new Node('div');
  const warns = [];
  const real = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  foldRows(host, new Node('div', 'tscroll'), { shown: 10, total: 200 });
  console.warn = real;
  check('a node with no table warns instead of returning quietly',
    warns.length === 1 && /no rows found/.test(warns[0]), JSON.stringify(warns));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
