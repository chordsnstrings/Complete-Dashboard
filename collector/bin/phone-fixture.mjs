#!/usr/bin/env node
/* Records the phone's API answers once, and the old skin's DOM from a named
   tree — the two files test/phone_classic.test.mjs and test/phone_arkiv.test.mjs
   read (see test/phone_harness.mjs for why both are recorded rather than
   asked of the mock at test time).

       node mockapi.mjs &                                  # PORT=8701 for a private one
       MOCK=http://localhost:8701 node bin/phone-fixture.mjs record
       git archive <commit> api/public | tar -x -C /tmp/base   # the tree the oracle is taken from
       node bin/phone-fixture.mjs oracle /tmp/base/api/public <commit>

   `record` walks every phone screen in BOTH skins, with every tap the tests
   make, and the window sheet open, so an endpoint only one branch asks for is
   in the file too. Re-recording changes the data (the mock is random), so the
   oracle has to be re-taken afterwards from the tree it certifies — the
   commit BEFORE the change being tested, never the change itself, or the
   oracle certifies whatever the change drew. */
import { writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launch, phonePage, SCREENS, DESKTOP_TABS, loadFixture, domOf, PUB } from '../test/phone_harness.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const [mode, treeArg, label] = process.argv.slice(2);

if (mode === 'record') {
  const MOCK = process.env.MOCK || 'http://localhost:8099';
  /* The instant the pages' clocks are frozen at, to the second, so the file
     reads the same "today" the mock answered for. */
  const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const answers = {};
  const answer = async (key, route) => {
    if (!answers[key]) {
      const r = await fetch(MOCK + key, { method: route.request().method(),
        headers: { accept: 'application/json' }, body: route.request().postData() || undefined });
      const type = r.headers.get('content-type') || 'application/json';
      const buf = Buffer.from(await r.arrayBuffer());
      answers[key] = /json|text/.test(type)
        ? { status: r.status, type, body: buf.toString('utf8') }
        : { status: r.status, type, b64: buf.toString('base64') };
    }
    const a = answers[key];
    await route.fulfill({ status: a.status, contentType: a.type,
      body: a.b64 ? Buffer.from(a.b64, 'base64') : a.body });
  };
  const browser = await launch();
  for (const skin of ['classic', 'arkiv']) {
    const p = await phonePage(browser, { skin, answer, at });
    for (const s of [...SCREENS, ...DESKTOP_TABS.map((route) => ({ route }))]) {
      await p.open(s.route);
      const tap = skin === 'arkiv' ? (s.tapArkiv || s.tap) : s.tap;
      if (tap) { await p.page.click(tap).catch(() => {}); await p.settle(); }
    }
    /* The window sheet, which asks the span of the data for its calendar. */
    await p.open('today');
    await p.page.click('.m-head button[title="Window and channels"], .ak-ctl button').catch(() => {});
    await p.settle();
    await p.close();
  }
  await browser.close();
  const body = JSON.stringify({ at, recordedFrom: 'mockapi.mjs', answers });
  writeFileSync(join(FIX, 'phone_api.json.gz'), gzipSync(body, { level: 9 }));
  console.log(`recorded ${Object.keys(answers).length} answers at ${at} (${body.length} bytes before gzip)`);
} else if (mode === 'oracle') {
  const root = treeArg || PUB;
  const fixture = loadFixture();
  if (!fixture) throw new Error('record the fixture first');
  const sha = createHash('sha256').update(readFileSync(join(FIX, 'phone_api.json.gz'))).digest('hex').slice(0, 16);
  const browser = await launch();
  const out = {};
  const p = await phonePage(browser, { skin: 'classic', fixture, root });
  for (const s of SCREENS) {
    await p.open(s.route);
    if (s.tap) { await p.page.click(s.tap); await p.settle(); }
    out[s.as || s.route] = await domOf(p.page);
  }
  await p.open('today');
  await p.page.click('.m-head button[title="Window and channels"]');
  await p.settle();
  await p.page.waitForTimeout(400);
  out['today+sheet'] = await domOf(p.page);
  const misses = [...p.misses];
  await p.close();
  await browser.close();
  writeFileSync(join(FIX, 'phone_classic_dom.json.gz'), gzipSync(JSON.stringify({
    tree: label || root, fixture: sha, at: fixture.at, misses, screens: out }), { level: 9 }));
  console.log(`oracle: ${Object.keys(out).length} screens from ${label || root}; ${misses.length} fixture misses`);
  if (misses.length) console.log(misses.join('\n'));
} else {
  console.error('usage: phone-fixture.mjs record | oracle <tree/api/public> <label>');
  process.exit(2);
}
