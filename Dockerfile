# syntax=docker/dockerfile:1
# One image definition; the two targets used by compose:
#   runtime (default) — production dependencies only, runs the API
#   test              — adds dev dependencies and the test suite, runs `npm test`
# Small Alpine base keeps a cold `make run` well inside the 180-second budget.

FROM node:24-alpine AS base
WORKDIR /app
# package-lock.json is required: `npm ci` installs exactly the pinned versions,
# so every build is reproducible. Regenerate it with `make lock`.
COPY package.json package-lock.json ./

FROM base AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM base AS test
ENV NODE_ENV=test
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY seed ./seed
COPY test ./test
CMD ["npm", "test"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY seed ./seed
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
