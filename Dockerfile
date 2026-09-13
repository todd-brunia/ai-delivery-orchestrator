FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS lambda-native

# RIC needs a Linux native addon. Keep dependency scripts disabled generally;
# rebuild only the reviewed, lockfile-pinned AWS runtime client in this stage.
RUN apt-get update && apt-get install --no-install-recommends -y \
    autoconf automake cmake g++ libtool make python3 xz-utils
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm_config_nodedir=/usr/local npm rebuild aws-lambda-ric --foreground-scripts

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=lambda-native /app/node_modules/aws-lambda-ric/rapid-client.node ./node_modules/aws-lambda-ric/rapid-client.node
RUN AWS_LAMBDA_RUNTIME_API=127.0.0.1:1 node -e "require('./node_modules/aws-lambda-ric/rapid-client.node')"
COPY --from=build /app/dist ./dist
COPY certificates ./certificates
COPY migrations ./migrations

ENV NODE_EXTRA_CA_CERTS=/app/certificates/aws-rds-us-east-1-rsa2048-g1.pem

USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "process.kill(1, 0)"]

CMD ["node", "dist/index.js"]
