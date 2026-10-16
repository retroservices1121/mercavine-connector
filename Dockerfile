FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
ENV PUBLIC_BASE_URL=http://127.0.0.1:4317
RUN npm run build
EXPOSE 4317
CMD ["npm", "start"]
