FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && node node_modules/agent-browser/bin/agent-browser.js install --with-deps \
 && rm -rf /var/lib/apt/lists/*
COPY . .
# Chrome runs as root in the container, which needs --no-sandbox.
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
EXPOSE 8080
# The volume at /data starts empty: seed the starter arches without overwriting saved edits.
CMD ["sh", "-c", "mkdir -p /data/personas && cp -n /app/data/personas/starter-*.json /data/personas/ ; exec node server.js"]
