import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
for (const [w, h, tag, period] of [[1440, 1400, 'wide', 'year'], [1440, 1400, 'month', 'month'],
                                   [900, 1200, 'narrow', 'month'], [420, 1100, 'phone', 'month']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => errs.push(`${tag}: ${e}`.slice(0, 200)));
  await p.goto(`http://127.0.0.1:8200/#cancellations?period=${period}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('tbody tr', { timeout: 60000 });
  await p.waitForTimeout(2500);
  const t = await p.evaluate(() => {
    const txt = document.body.innerText, i = txt.indexOf('CANCELLATIONS');
    const head = [...document.querySelectorAll('thead th')].map((x) => x.innerText.trim());
    const r0 = [...(document.querySelector('tbody tr')?.cells || [])].map((c) => c.innerText.trim().replace(/\n/g, ' '));
    return { band: txt.slice(i, i + 250).replace(/\s*\n\s*/g, ' · '), head, r0,
             overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
             hint: (txt.match(/Scroll the table sideways[^.]*\./) || ['none'])[0] };
  });
  console.log(`\n--- ${tag} ${w}px (${period}) overflow=${t.overflow} scrollHint=${t.hint}`);
  if (tag === 'wide') { console.log('  cols:', t.head.join(' | ')); console.log('  top row:', t.r0.join(' | ')); console.log('  band:', t.band); }
  await p.screenshot({ path: `/tmp/prod-${tag}.png`, fullPage: tag === 'wide' });
  await p.close();
}
console.log('\npage errors:', errs.length ? errs : 'none');
await b.close();
