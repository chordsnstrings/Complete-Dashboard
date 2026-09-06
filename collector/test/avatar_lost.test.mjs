/* A photograph that will not load must SAY SO, and this is asked of the page,
   not of the source file.
   ─────────────────────────────────────────────────────────────────────────
   The product's own principle is that a thing which cannot be shown renders
   absent WITH A REASON, never silently. For a driver that means three states,
   not two: we hold no photograph (initials, and that is the whole truth), we
   hold one and it would not load (initials, marked, with the reason in words),
   and we hold one and here it is.

   The middle state is the one that keeps breaking. First as
   `onerror="this.remove()"`, which deleted the image and revealed the initials
   underneath — that is how 156 dead CloudFront avatars looked like a normal
   page for two days. Then again inside the fix for it:

       onerror="this.remove(); this.parentNode.classList.add('av-lost'); …"

   Element.remove() detaches the img, so `this.parentNode` is null one
   statement later and the handler dies with a TypeError before it marks
   anything. Same rendering as before, same silence — there is no window error
   handler in api/public, so the exception went nowhere either.

   test/driver_photo.test.mjs asked whether the string 'av-lost' appears in
   ui.js. It does. It appeared in a statement that could not run. So the whole
   guard passed, green, against a page doing exactly what it was written to
   stop. This file asks the browser instead: load a broken image through the
   real avatar(), wait for the error, and read the class and the title off
   whatever is left on screen. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
/* A 404 on the photo route, which is exactly what the product serves for a
   driver whose bytes it does not hold — and what an expired CDN object used to
   answer with a 403. Either way the <img> fires error. */
app.get('/api/driver/photo/*', (_, res) => res.status(404).json({ error: 'no photo on file' }));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();

for (const [shell, mod, page] of [
  ['desktop', '/ui.js', '/index.html'],
  ['phone', '/m/ui.js', '/index.html'],
]) {
  const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
  await p.goto(`http://127.0.0.1:${port}${page}`, { waitUntil: 'domcontentloaded' });

  console.log(`\n── ${shell} ──`);

  const out = await p.evaluate(async (m) => {
    const ui = await import(m);
    const host = document.createElement('div');
    document.body.append(host);
    const wait = () => new Promise((r) => setTimeout(r, 700));

    /* avatar() returns a string on the desktop and an element on the phone;
       both are accepted, because what is being asserted is what ends up on
       the screen and not which shape the helper happens to return. */
    const put = (v) => {
      const box = document.createElement('div');
      if (typeof v === 'string') box.innerHTML = v; else box.append(v);
      host.append(box);
      return box.firstElementChild;
    };
    const broken = put(ui.avatar('Jane Doe', '/api/driver/photo/uber/does-not-exist'));
    const none = put(ui.avatar('Jane Doe', null));
    await wait();
    const read = (e) => ({ cls: e ? e.className : null, title: e ? (e.title || '') : null,
      hasImg: !!e?.querySelector('img'), text: e ? e.textContent.trim() : null });
    return { broken: read(broken), none: read(none) };
  }, mod);

  check('a photograph that will not load leaves a mark on the tile',
    /av-lost/.test(out.broken.cls || ''), JSON.stringify(out.broken));
  check('…and the mark carries the reason in words',
    /could not be loaded/i.test(out.broken.title || ''), JSON.stringify(out.broken.title));
  check('…and the handler did not throw on the way there', errors.length === 0, errors.join(' | '));
  /* THE POINT. Both states fall back to initials, so the mark is the only
     thing separating "we hold none" from "we hold one and it is unreachable".
     If the two render identically the page is telling the reader something
     false about the fleet's records. */
  check('a driver with no photograph on file is NOT marked',
    !/av-lost/.test(out.none.cls || ''), JSON.stringify(out.none));
  check('…so the two absences do not render identically',
    out.broken.cls !== out.none.cls, `${out.broken.cls} vs ${out.none.cls}`);
  check('…and the initials are still underneath either way',
    /JD/.test(out.broken.text || '') && /JD/.test(out.none.text || ''),
    `${out.broken.text} / ${out.none.text}`);
  await p.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
