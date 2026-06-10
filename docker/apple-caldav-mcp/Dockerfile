FROM node:24-alpine

WORKDIR /app

COPY apple-caldav-mcp/package.json apple-caldav-mcp/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY apple-caldav-mcp/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]
