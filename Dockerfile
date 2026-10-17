FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
ENV PUBLIC_BASE_URL=http://127.0.0.1:4317
RUN npm run build
EXPOSE 4317
# Runs as root on purpose: the SQLite DB lives on a Railway volume
# (RAILWAY_VOLUME_MOUNT_PATH / MERCAVINE_DB_PATH), and Railway mounts volumes
# root-owned, so a non-root user could not write the database.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["npm", "start"]
