FROM node:20-alpine

# su-exec drops from root to the node user in docker-entrypoint.sh
RUN apk add --no-cache su-exec

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL deps (needed for build)
RUN npm ci

# Copy source
COPY . .

# Build the production bundle
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health > /dev/null || exit 1

# The SQLite database (trades, grid bots, engine state) lives on a volume.
# Without one it was written inside the container and lost on every redeploy.
# Mount something at /data: `docker run -v powerhouse-data:/data ...`, or a
# Railway volume with mount path /data.
ENV DATA_DB_PATH=/data/data.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Start as the unprivileged node user (see docker-entrypoint.sh)
ENV NODE_ENV=production
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.cjs"]
