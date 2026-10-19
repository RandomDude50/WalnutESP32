FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim
ENV PLATFORMIO_CORE_DIR=/opt/pio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=no \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir platformio

WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./

# Template firmware + pre-riscaldamento della cache PlatformIO (toolchain, framework, librerie):
# le compilazioni a runtime sono veloci e non dipendono dalla rete.
COPY firmware /opt/firmware-template
RUN cp -r /opt/firmware-template /tmp/warm \
 && pio run -d /tmp/warm \
 && rm -rf /tmp/warm

COPY --from=web /web/dist /app/public

RUN useradd -m app && mkdir -p /data/artifacts /data/jobs && chown -R app:app /opt/pio /data
USER app
ENV TEMPLATE_DIR=/opt/firmware-template \
    STATIC_DIR=/app/public \
    WORK_DIR=/data/jobs \
    ARTIFACT_DIR=/data/artifacts \
    PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
