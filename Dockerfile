# Yahoo Mail MCP Server - Dockerfile
# Multi-stage build: install production deps in one stage, copy into a clean runtime image.
# All dependencies (imap, mailparser, express, MCP SDK) are pure JavaScript, so no
# compiler toolchain (python3/make/g++) is needed in either stage.
# Works on both Windows Docker Desktop and Linux Docker

FROM node:24-alpine AS dependencies

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS production

WORKDIR /app

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Copy production dependencies and application code
COPY --from=dependencies --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs package*.json server.js ./

USER nodejs

# Expose the port (Render will provide PORT via env variable)
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production
ENV TRANSPORT_MODE=sse

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the server
CMD ["node", "server.js"]
