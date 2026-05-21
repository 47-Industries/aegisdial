FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
COPY certs ./certs
# Internal founder dashboard HTML — served by src/routes/internal.ts
# at /internal/dashboard. Without this COPY, /internal/dashboard
# would 500 in prod even though the route handler is registered.
COPY public ./public
# Legal + support HTML (privacy, terms, support, index). Served at
# api.aegisdial.com/privacy etc as a fallback for when the standalone
# aegisdial-web Railway service is unhealthy.
COPY legal ./legal
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
