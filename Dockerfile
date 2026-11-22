FROM node:22.18.0-bookworm-slim
WORKDIR /bot
COPY bot.ts mechfight.ts package.json ./
ENTRYPOINT ["node", "/bot/bot.ts"]
