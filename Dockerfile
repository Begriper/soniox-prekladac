FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.js ./
COPY public ./public
RUN mkdir /data && chown node:node /data /app
ENV NODE_ENV=production
ENV PORT=8080
ENV USAGE_DB_PATH=/data/usage.sqlite
USER node
EXPOSE 8080
CMD ["node", "server.js"]
