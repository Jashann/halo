# Build from the jarvis-vr root:  docker build -f server/Dockerfile -t halo .
# One container: the built web app (web/dist) and the agent server on the same port.

# Web build stage (the IWSDK app asks for Node 22.12+).
FROM node:22-slim AS web
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm_config_onnxruntime_node_install_cuda=skip
WORKDIR /app/web
COPY web/ ./
RUN if [ -f package.json ]; then \
      (if [ -f package-lock.json ]; then npm ci; else npm install; fi) && npm run build; \
    else mkdir -p dist; fi

# Runtime stage.
FROM node:20-slim
# ffmpeg remuxes WebM/Opus voice clips to Ogg for transcription
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web/dist
ENV NODE_ENV=production PORT=8080 AIDE_DATA_DIR=/data WEB_DIST=/app/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
