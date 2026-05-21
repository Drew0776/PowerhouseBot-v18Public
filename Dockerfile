FROM node:20-alpine

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
  CMD wget -qO- http://localhost:5000/api/auto-trader > /dev/null || exit 1

# Start
ENV NODE_ENV=production
CMD ["node", "dist/index.cjs"]
