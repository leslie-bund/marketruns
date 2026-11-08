FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    BIND_ADDRESS=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY models/ /models/
RUN mkdir -p /home/node/.ssh \
    && chown -R node:node /models /home/node/.ssh \
    && chmod 0700 /home/node/.ssh
USER node
EXPOSE 8791
CMD ["node", "dist/index.js"]
