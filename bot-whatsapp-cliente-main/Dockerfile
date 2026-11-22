FROM node:24-bookworm AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-por \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=10000 \
    OCR_TURBO_MODE=true \
    OCR_VARIANT_CONCURRENCY=4 \
    UV_THREADPOOL_SIZE=16
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 10000
CMD ["node", "dist/server.js"]
