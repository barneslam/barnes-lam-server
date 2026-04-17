FROM node:20-alpine

WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js index.html ./

# Data directory (mounted as a persistent volume on Fly.io)
RUN mkdir -p /data

EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "server.js"]
