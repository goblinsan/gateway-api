# ---- Build ghp binary ----
FROM golang:1.24-alpine AS ghp-builder
RUN apk add --no-cache git
WORKDIR /src
ARG GHP_REPO=https://github.com/goblinsan/gh-project-helper.git
ARG GHP_REF=main
RUN git clone --depth 1 --branch ${GHP_REF} ${GHP_REPO} . \
    && go build -ldflags "-s -w" -o /ghp ./cmd/gh-project-helper

# ---- Build Node app ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY jobs ./jobs
COPY --from=ghp-builder /ghp /usr/local/bin/ghp

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
