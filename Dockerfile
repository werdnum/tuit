FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# The server runs with plain node, so drop npm once dependencies are installed. The npm the base
# image bundles vendors its own undici and brace-expansion, which scanners report against the
# image and which no lockfile here can upgrade.
RUN npm ci --omit=dev && npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY src ./src
COPY bin ./bin
# Not used by the server: shipped so images that bundle the CLI can copy the matching agent skill.
COPY skills ./skills
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
