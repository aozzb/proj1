# Multi-stage build.
# - `dev`  : full deps + source, runs tsx watch (used by docker-compose for CP1).
# - `prod` : compiled dist + production deps only, runs as non-root (used later).

FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# ---- dev ----
FROM base AS dev
ENV NODE_ENV=development
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]

# ---- build ----
FROM base AS build
RUN npm install
COPY . .
RUN npm run build

# ---- prod ----
FROM node:22-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER node
CMD ["node", "dist/index.js"]
