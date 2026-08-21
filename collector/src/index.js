// Entrypoint. Usage:
//   node src/index.js migrate       — create/upgrade schema
//   node src/index.js backfill      — pull the last N months (one-off)
//   node src/index.js incremental   — pull the trailing window (one-off)
//   node src/index.js schedule      — long-running: cron incrementals + realtime polling (container default)
import cron from 'node-cron';
import { migrate, pool } from './db.js';
import { backfill, incremental, cabmanTick, liveStatusTick } from './run.js';
import { config } from './config.js';
import { log } from './log.js';

const cmd = process.argv[2] || 'schedule';

async function main() {
  await migrate();
  if (cmd === 'migrate') return;
  if (cmd === 'backfill') return backfill();
  if (cmd === 'incremental') return incremental();

  if (cmd === 'schedule') {
    log.info('scheduler', 'starting', {
      cabmanCron: config.cabmanCron, liveStatusSeconds: config.liveStatusSeconds, incrementalDays: config.incrementalDays,
    });
    // CABMAN realtime GPS — every 5 minutes, saved to the database
    cron.schedule(config.cabmanCron, () => cabmanTick());
    // Uber/FMS live status — lighter interval
    setInterval(() => liveStatusTick(), config.liveStatusSeconds * 1000);
    // historical/aggregate refresh every 30 minutes
    cron.schedule('*/30 * * * *', () => incremental().catch((e) => log.error('scheduler', 'incremental', { err: String(e) })));
    // kick one of each at boot so the dashboard has fresh data immediately
    cabmanTick();
    incremental().catch((e) => log.error('scheduler', 'boot-incremental', { err: String(e) }));
    return new Promise(() => {}); // run forever
  }
  log.error('index', `unknown command: ${cmd}`);
  process.exit(1);
}

main().then(async () => {
  if (cmd !== 'schedule') { await pool.end(); process.exit(0); }
}).catch((e) => { log.error('index', 'fatal', { err: String(e) }); process.exit(1); });
