# Single image: builds the SPA, then runs the API + sync worker that serves it.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
RUN npm install --omit=dev --workspace @moodify/backend --include-workspace-root \
  && npm cache clean --force
COPY packages/shared packages/shared
COPY apps/backend apps/backend
COPY --from=build /app/apps/frontend/dist apps/frontend/dist

# Assets volume: uploaded logos/backgrounds and cached badge images.
RUN mkdir -p /data/assets && chown -R node:node /data/assets
USER node
EXPOSE 8080
CMD ["npm", "run", "start", "--workspace", "@moodify/backend"]
