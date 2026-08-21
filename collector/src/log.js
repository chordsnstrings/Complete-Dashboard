// Minimal structured logger.
const ts = () => new Date().toISOString();
const fmt = (lvl, src, msg, extra) =>
  `${ts()} ${lvl.padEnd(5)} [${src}] ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');

export const log = {
  info:  (src, msg, extra) => console.log(fmt('INFO', src, msg, extra)),
  warn:  (src, msg, extra) => console.warn(fmt('WARN', src, msg, extra)),
  error: (src, msg, extra) => console.error(fmt('ERROR', src, msg, extra)),
};
