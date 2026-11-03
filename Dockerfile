FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY bin ./bin
# Not used by the server: shipped so images that bundle the CLI can copy the matching agent skill.
COPY skills ./skills
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
