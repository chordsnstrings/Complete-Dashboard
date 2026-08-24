import { launchChromium } from './test/browser.mjs';
const b = await launchChromium();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
for (const r of process.argv.slice(2)) {
  await p.goto(`http://localhost:8099/#${r}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `/tmp/s-${r.replace(/\//g,'_')}.png`, fullPage: true });
}
await b.close(); console.log('done');
