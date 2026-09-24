/* The phone's component vocabulary.
   ─────────────────────────────────────────────────────────────────────────
   Small on purpose. Everything that already exists and is not shaped by the
   screen — el(), esc(), money(), pct(), the date formatters, fmt() — is
   imported from the desktop modules rather than rewritten, so a change to how
   this product writes a number reaches both applications at once.

   What IS here is the handful of things a thumb needs and a mouse does not: a
   row instead of a table, a sheet instead of a dropdown, a segmented control
   instead of a select, and a sparkline small enough to sit inside a stat. */
import { el, esc, money, pct, dayStr, secHead, highlight } from '../ui.js';
import { fmt, isToday, spark } from '../charts.js';
import { channelKey } from '../tokens.js';

export { el, esc, money, pct, dayStr, fmt, isToday, spark };

/* ── which phone app to build ──────────────────────────────────────────────
   The operator's ruling of 2026-09-24 gives the phone a redesign
   (docs/UI-REDESIGN-PLAN.md, "Phone PWA — redesign"), and production keeps
   today's phone until the default skin is flipped. Which of the two a render
   builds is a TOKEN, as it is on the desktop (ui.js contract() reads
   --pg-contract, shell.js shellContract() reads --pg-shell): app.css
   declares --pg-phone:0, and m/arkiv-m.css — which index.html writes only for
   a phone reader under ?skin=arkiv — declares 1. No module reads the skin
   attribute (test/arkiv_skin.test.mjs scans every one); a stylesheet the
   reader was given is what decides.

   Every component below asks, so the answer is kept until the set of loaded
   stylesheets changes: a getComputedStyle per row, on a list of three hundred
   rows, is a layout flush per row. A sheet that lands late changes the count
   and is re-read. No stylesheet at all (a test harness, a detached document)
   answers the old phone, which is what production draws. */
let pcSheets = -1, pcSays = false;
export function phoneContract() {
  try {
    const n = document.styleSheets.length;
    if (n !== pcSheets) {
      pcSheets = n;
      pcSays = String(getComputedStyle(document.documentElement).getPropertyValue('--pg-phone')).trim() === '1';
    }
    return pcSays;
  } catch { return false; }
}

/* Today is not a day yet.
   ─────────────────────────────────────────────────────────────────────────
   /api/trips/daily fills the window to its last day, and the last day is
   TODAY — six hours old at breakfast. Averaged in, it drags every per-day
   figure down; compared against yesterday, it reads as a collapse. The phone
   did both: its headline said "the last full day ran down 81% on the one
   before it" every single morning, and the day it was measuring was the one
   still being collected.

   The desktop already separates them — gapBars draws today as unfinished
   (hollow, or a hatch under Arkiv) and says so. This is the same separation
   for a screen with no chart to hang it on: the complete days for anything
   averaged or compared, and today handed back on its own so a screen can
   mention it as what it is. */
/* `d` or `day`. The Today module's rows carry `d`; /api/driver/daily's carry
   `day`, so a driver chart calling this got `today: null` every time and
   plotted the part-day that is still filling as though it were a whole one. */
export const splitToday = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  const last = list[list.length - 1];
  return isToday(last?.d ?? last?.day)
    ? { complete: list.slice(0, -1), today: last }
    : { complete: list, today: null };
};

/* Most list endpoints answer with an envelope — {rows, shown, truncated} —
   and a few answer with a bare array. Reading `.rows` off an array yields
   undefined and an empty screen that looks like a quiet week, so both shapes
   are unwrapped in one place. The count and the truncation come with it,
   because a list that was cut has to say so. */
export const unwrap = (d) => {
  if (Array.isArray(d)) return { rows: d, total: d.length, truncated: false };
  if (!d || typeof d !== 'object') return { rows: [], total: 0, truncated: false };
  const rows = d.rows || d.list || [];
  return {
    rows,
    total: d.total ?? d.people ?? d.totals?.vehicles ?? rows.length,
    truncated: !!d.truncated,
  };
};

/* The line under a cut list. Never omitted: a phone shows ten rows of
   seventy-four and the reader cannot see the scrollbar that would have
   hinted at it. */
/* WHICH N OF THE M, and the word has to be true of the ORDER the caller used.
   ─────────────────────────────────────────────────────────────────────────
   This said "busiest" unconditionally, which is right for every list it was
   written for and false for the first one that is date-ordered: the payouts
   screen showed twenty-five transfers newest first under "The 25 busiest of
   303 transfers", measured on production 2026-09-18. Busiest is a claim about
   ranking, and nothing had ranked these.

   `pick` names the order. Defaulted to 'busiest' so every existing call site
   is unchanged, and a list that is not ranked passes its own word. */
export const cut = (host, { rows, total, truncated }, noun, pick = 'busiest') => {
  if (!truncated && rows.length >= total) return null;
  const p = el('p', 'm-cap');
  p.style.cssText = 'margin:8px 2px 0;text-align:center';
  p.textContent = `The ${rows.length} ${pick} of ${fmt(total)} ${noun}.`;
  host.append(p);
  return p;
};

export const card = (title, cap) => {
  const c = el('div', 'm-card');
  if (title) c.append(el('h2', null, esc(title)));
  if (cap) c.append(el('p', 'm-cap', esc(cap)));
  const body = el('div', 'm-body');
  c.append(body);
  return { card: c, body };
};

/* One sentence and the number it is about. The claim comes first because on a
   phone the first line is often the only line read. */
/* ── a person's face, or their initials ───────────────────────────────────
   The initials stay UNDERNEATH the photo rather than being replaced by it: an
   avatar that fails to load must degrade to the thing it replaced rather than
   to an empty box. The url is no longer a remote CloudFront object — it is
   this product's own /api/driver/photo/… address for bytes it holds, because
   the CloudFront one authorised for twelve hours and the collector that wrote
   it runs weekly. The img removes itself on error, so
   the fallback is already painted before it is needed. Same rule as the
   desktop's avatar() in api/public/ui.js. */
export const initialsOf = (name) => String(name || '?')
  .split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';

export const avatar = (name, pictureUrl, cls = '', absentReason = null) => {
  const d = el('div', `m-av${cls ? ` ${cls}` : ''}`, esc(initialsOf(name)));
  /* Three states, the same three the desktop draws. See avatar() in
     api/public/ui.js: a plain tile is "no photograph on this person's record",
     a marked one is "there is one and we do not have it".

     ON A PHONE THE REASON CANNOT BE A TOOLTIP. There is no hover on a touch
     screen, so title alone puts the words somewhere the reader can never
     reach. aria-label carries them to a screen reader, and the mark carries
     the fact to everyone else. */
  if (!pictureUrl && absentReason) {
    const words = `Uber holds a photograph of this driver and this product does not: ${absentReason}`;
    d.classList.add('av-lost');
    d.title = words;
    d.setAttribute('aria-label', `${name} — ${words}`);
    return d;
  }
  if (!pictureUrl) return d;
  d.classList.add('has-photo');
  const img = el('img');
  img.src = pictureUrl;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  /* Same rule as the desktop's avatar(): a photograph we hold an address for
     and cannot fetch is a FAULT, and it must not look identical to a driver
     who simply has no photograph on file. Removing the img alone made 156
     dead images render as a perfectly normal page for two days. */
  img.onerror = () => {
    img.remove();
    d.classList.add('av-lost');
    const words = 'This driver has a photograph on file and it could not be loaded.';
    d.title = words;
    /* A title is a tooltip and a phone has no hover, so on this shell the
       sentence exists only for a reader who can reach it another way. */
    d.setAttribute('aria-label', `${name} — ${words}`);
  };
  d.append(img);
  return d;
};

export const lede = (host, { claim, sub, tone, name, photo }) => {
  const d = el('div', `m-lede${tone ? ` ${tone}` : ''}`);
  /* A person's lede leads with their face. Everything else keeps the shape it
     had, so this is additive rather than a second kind of lede. */
  if (name !== undefined) {
    const head = el('div', 'm-lede-head');
    head.append(avatar(name, photo));
    const t = el('div', 'm-lede-text');
    t.append(el('b', null, esc(claim)));
    if (sub) t.append(el('p', null, esc(sub)));
    head.append(t);
    d.append(head);
    host.append(d);
    return d;
  }
  d.append(el('b', null, esc(claim)));
  if (sub) d.append(el('p', null, esc(sub)));
  host.append(d);
  return d;
};

export const stat = ({ label, value, sub, tone, href, long }) => {
  const s = el(href ? 'a' : 'div', `m-stat${tone ? ` ${tone}` : ''}`);
  if (href) s.href = href;
  s.append(el('span', 'l', esc(label)));
  /* THE REASON IN THE VALUE SLOT, under the redesign (SPEC §5, the desktop's
     glance `na`): a figure that cannot be measured prints why, never a bare
     dash. The old tile put "—" in the figure and the reason in the line under
     it, which on a phone is the smaller, greyer line — the one a reader skips.
     When the tile carries its reason as its sub, the reason moves up into the
     value slot and is marked absent, so highlight() refuses it (L4: an
     absent figure is explained, never emphasised). A dash with no reason
     beside it stays a dash, marked absent: the words for it are the screen's
     to supply, never this component's to invent. */
  if (phoneContract() && isAbsent(value)) {
    const why = sub || null;
    const n = el('span', `n t-na${why ? '' : ' sm'}`, esc(why || String(value)));
    n.dataset.absent = '';
    s.append(n);
    return s;
  }
  const n = el('span', `n${long || String(value).length > 9 ? ' sm' : ''}`, esc(String(value)));
  s.append(n);
  if (sub) s.append(el('span', 's', esc(sub)));
  return s;
};
/* What a screen passes when it has no figure: the em dash, or the words
   "not measured". Nothing else is read as absent — a zero is a measurement. */
const isAbsent = (v) => v == null || v === '' || v === '—' || v === '-' || v === 'not measured';

export const stats = (host, list, three = false, { hero = false } = {}) => {
  const g = el('div', `m-stats${three ? ' three' : ''}`);
  list.filter(Boolean).forEach((s) => g.append(stat(s)));
  host.append(g);
  /* THE HERO (the redesign only): the tile marked `hero`, or the first,
     spans the row at the display size and carries the screen's one counted
     highlight (SPEC L4, ui.js highlight(): refused on an absent figure, and
     one per band). */
  if (hero && phoneContract()) {
    g.dataset.band = 'glance';
    const kids = [...g.children];
    const at = Math.max(0, list.filter(Boolean).findIndex((t) => t.hero));
    const h = kids[at];
    if (h) {
      h.classList.add('hero');
      const n = h.querySelector('.n');
      if (n && !n.hasAttribute('data-absent')) {
        n.classList.remove('sm');
        highlight(n, 'ink');
      }
    }
  }
  return g;
};

/* 00 · AT A GLANCE (the redesign only). SPEC §1's contract, on a phone: the
   section head — the desktop's own secHead(), so the number, the rule and the
   words are the desktop's — then the tiles with their hero. `note` is the
   head's right-hand line: the window the tiles are over. */
export const atGlance = (host, list, { note = null, three = false } = {}) => {
  host.append(secHead('00', 'At a glance', note));
  return stats(host, list, three, { hero: true });
};

/* A row is an identity, a figure, and one line of why. `to` makes it a link,
   which is what a drill-down is here — an address, not a modal. */
export const row = ({ title, sub, value, note, to, tone, name, photo }) => {
  /* A link gets a chevron in a slot of its own. Putting one in the figure
     column made it share the right edge with a tabular number, and the two
     took turns being clipped. */
  const r = el(to ? 'a' : 'div', `m-row${to ? ' go' : ''}`);
  if (to) r.href = to;
  /* A person's row leads with their face, at the row's own size. Rows that are
     not about a person pass no `name` and keep exactly the shape they had. */
  if (name !== undefined) r.append(avatar(name, photo, 'sm'));
  /* A FIGURE TO THE FILS IS THREE CHARACTERS WIDER, AND THE SUB LINE PAID FOR
     IT. The value column is sized to its content and the sub line
     (.m-row .k span) is nowrap with an ellipsis, so when every money figure
     gained its ".00" on 2026-09-23 (the operator's money ruling), #payouts'
     "Every transfer" rows lost the end of "Uber · Ecosine · settles Aug 31–
     Sep 6" by 5px at 390px — measured by test/payout_mobile.test.mjs. A row
     whose figure is longer than a whole-dirham one lets its sub take a second
     line instead (the .wrapsub rule the comparison rows already use); a
     short figure keeps the one-line row it had. */
  if (sub && String(value ?? '').length > 11) r.classList.add('wrapsub');
  const k = el('div', 'k');
  k.append(el('b', null, esc(title)));
  if (sub) k.append(el('span', null, esc(sub)));
  r.append(k);
  const v = el('div', 'v');
  if (value != null && value !== '' && value !== '\u203a') {
    const b = el('b', null, esc(String(value)));
    /* Under the redesign the figure stays INK and the tone becomes the dot
       before it (ruling 1: hollow for a warning, solid for critical or bad,
       solid green for good), carried as a class m/arkiv-m.css draws \u2014 an
       inline colour would outrank the sheet and paint the digits. */
    if (tone && phoneContract()) r.classList.add(`t-${tone}`);
    else if (tone) b.style.color = `var(--${tone})`;
    v.append(b);
  }
  if (note) v.append(el('span', null, esc(note)));
  r.append(v);
  if (to) r.append(el('span', 'chev', '\u203a'));
  return r;
};

export const rows = (host, list) => {
  const box = el('div', 'm-rows');
  list.filter(Boolean).forEach((r) => box.append(r instanceof Node ? r : row(r)));
  host.append(box);
  return box;
};

/* The control owns which of its buttons is lit. Callers used to re-derive that
   by comparing button text to a label map, which is a second source of truth
   that goes wrong the first time a label is reworded. */
export const seg = (host, options, active, onPick) => {
  const s = el('div', 'm-seg');
  const btns = options.map((o) => {
    const b = el('button', o.id === active ? 'on' : null, esc(o.label));
    b.type = 'button';
    b.dataset.id = o.id;
    b.onclick = () => {
      btns.forEach((x) => x.classList.toggle('on', x.dataset.id === o.id));
      onPick(o.id);
    };
    s.append(b);
    return b;
  });
  host.append(s);
  return s;
};

export const chips = (host, options, active, onPick) => {
  const c = el('div', 'm-chips');
  options.forEach((o) => {
    const a = el('button', `m-chip${o.id === active ? ' on' : ''}`, esc(o.label));
    a.type = 'button';
    a.onclick = () => onPick(o.id);
    c.append(a);
  });
  host.append(c);
  return c;
};

export const search = (host, placeholder, onType) => {
  const w = el('div', 'm-search');
  w.append(el('span', null, '⌕'));
  const i = el('input');
  i.type = 'search'; i.placeholder = placeholder; i.autocomplete = 'off';
  /* Typed on a phone keyboard, so it debounces: filtering 300 drivers on
     every keystroke made the field itself feel broken. */
  let t = null;
  i.oninput = () => { clearTimeout(t); t = setTimeout(() => onType(i.value.trim()), 130); };
  w.append(i);
  host.append(w);
  return i;
};

export const skeleton = (host, n = 3) => {
  host.innerHTML = '';
  for (let i = 0; i < n; i++) host.append(el('div', 'm-skel'));
};

export const empty = (host, title, why) => {
  const d = el('div', 'm-card');
  d.innerHTML = `<div class="m-empty"><b>${esc(title)}</b>${esc(why || '')}</div>`;
  host.append(d);
  return d;
};

export const failed = (host, e) => {
  const d = el('div', 'm-card m-err');
  d.innerHTML = `<div class="m-empty"><b>Could not load this</b>${esc(
    /offline/i.test(String(e && e.message)) ? 'No network, and nothing cached for it yet.'
      : String((e && e.message) || e))}</div>`;
  host.append(d);
  return d;
};

/* spark() lives in ../charts.js now (reskin STEP 3), so the desktop glance
   tiles and this shell draw one sparkline; it is re-exported above, and its
   floor-at-zero history moved with it. */

/* Proportion as a stack of bars rather than a donut: a donut at 120px wide is
   a coloured ring with the labels somewhere else. */
export const bars = (host, list, { max = 6 } = {}) => {
  const all = list.filter((r) => Number(r.n) > 0);
  const rowsIn = all.slice(0, max);
  /* The share is of EVERYTHING, not of the six that fitted. Dividing by the
     visible rows made five payment types read 17% each and sum to 84%, which
     is a percentage of nothing the reader can name. */
  const total = all.reduce((a, r) => a + Number(r.n), 0) || 1;
  if (phoneContract()) return inkBars(host, all, rowsIn, total);
  const box = el('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:9px';
  rowsIn.forEach((r, i) => {
    const line = el('div');
    line.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:baseline';
    line.append(el('span', null, esc(r.label)), (() => {
      const s = el('span', 'num');
      s.style.cssText = 'font-size:.8rem;color:var(--grey-strong)';
      s.textContent = `${fmt(r.n)} · ${Math.round((r.n / total) * 100)}%`;
      return s;
    })());
    const track = el('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden;margin-top:5px';
    const fillEl = el('div');
    fillEl.style.cssText = `height:100%;width:${(r.n / total) * 100}%;`
      + `background:var(--s${(i % 6) + 1});border-radius:3px`;
    track.append(fillEl);
    const wrap = el('div');
    wrap.style.fontSize = '.83rem';
    wrap.append(line, track);
    box.append(wrap);
  });
  if (all.length > rowsIn.length) {
    const rest = all.slice(rowsIn.length).reduce((a, r) => a + Number(r.n), 0);
    const more = el('p', 'm-cap');
    more.style.cssText = 'margin:2px 0 0;font-size:.74rem';
    more.textContent = `${all.length - rowsIn.length} more, `
      + `${Math.round((rest / total) * 100)}% between them.`;
    box.append(more);
  }
  host.append(box);
  return box;
};

/* The same proportions, drawn to the redesign's mark rules (SPEC §4, L1).
   ─────────────────────────────────────────────────────────────────────────
   The bars above take their fill from --s1..--s6 BY POSITION, which under
   the Arkiv law is a hue cycled by index — and every non-semantic hue there
   names a channel, so a settlement class drawn in the second slot would read
   as a channel it is not. These rows are parts of one number (settlement
   routes, harsh-driving kinds), none of them a channel, so every bar is INK,
   ranked, with the share printed beside the count and no coloured track: a
   bar ≤ 8px thick with a square baseline and a 4px data end. Same rows, same
   denominator (everything, not the rows that fitted), same "N more" line. */
function inkBars(host, all, rowsIn, total) {
  const box = el('div', 'ak-bars');
  rowsIn.forEach((r) => {
    const line = el('div', 'ak-bar');
    const h = el('div', 'ak-bar-h');
    h.append(el('span', 'ak-bar-l', esc(r.label)),
      el('span', 'ak-bar-n', esc(`${fmt(r.n)} · ${Math.round((r.n / total) * 100)}%`)));
    const track = el('div', 'ak-bar-t');
    const fill = el('i');
    fill.style.width = `${(r.n / total) * 100}%`;
    track.append(fill);
    line.append(h, track);
    box.append(line);
  });
  if (all.length > rowsIn.length) {
    const rest = all.slice(rowsIn.length).reduce((a, r) => a + Number(r.n), 0);
    box.append(el('p', 'm-cap', esc(`${all.length - rowsIn.length} more, `
      + `${Math.round((rest / total) * 100)}% between them.`)));
  }
  host.append(box);
  return box;
}

/* A row's channel, as SPEC §4's ROW MARKER (the redesign only): a 3px rule
   in the channel's identity in the row's gutter — never a tinted row, never
   the row's words in a colour (L5.6). The mark is the channel's by NAME
   (tokens.js channelKey); a name that is not one of the six marks nothing,
   so an unidentified feed looks unidentified (L1). m/arkiv-m.css draws it. */
export const rowMark = (rowEl, name) => {
  const k = channelKey(String(name ?? ''));
  if (rowEl && k && phoneContract()) rowEl.dataset.ch = k;
  return rowEl;
};
