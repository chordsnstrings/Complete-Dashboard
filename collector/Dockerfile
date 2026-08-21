FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# default: long-running scheduler (cron incrementals + realtime polling)
CMD ["node", "src/index.js", "schedule"]
