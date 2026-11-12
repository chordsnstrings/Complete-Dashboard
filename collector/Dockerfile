# Node 22 (integration of the 2026-11-12 batch): Node 20 left support on
# 2026-04-30, and CI and the sandbox — where all 394+ suites run — are on 22,
# so a green run now proves the runtime production uses (COVERAGE: "Production
# runs Node 20; CI and this sandbox run Node 22", resolved). Every dependency
# is plain JavaScript; nothing is compiled at install.
FROM node:22-slim
WORKDIR /app
# Exactly the lockfile CI installs, not whatever the ranges resolve to on the
# day of the build: `npm ci` refuses a lockfile out of step with package.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# default: long-running scheduler (cron incrementals + realtime polling)
CMD ["node", "src/index.js", "schedule"]
