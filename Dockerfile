# Static Go HTTP API with the Chromium headless shell used for WAF challenges.
# TARGET_URL and cookies are runtime-only; never add them as build args or ENV.

# Install the browser and prune it in a throwaway stage.
FROM node:22-alpine AS browser
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories \
 && apk add --no-cache chromium-headless-shell font-wqy-zenhei
COPY prune.sh /prune.sh
RUN sh /prune.sh

# Compile the API as a static Linux binary. Go and module sources stay in builder.
FROM golang:1.25-alpine3.24 AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server.go ./
ARG TARGETARCH
RUN mkdir -p /out \
 && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/waf-api .

# Production API (default Compose target): Alpine + static Go + Chromium runtime.
FROM alpine:3.24 AS api
RUN apk add --no-cache ca-certificates
COPY --from=go-builder /out/waf-api /usr/local/bin/waf-api
COPY --from=browser /opt/keep/chromium/ /usr/lib/chromium/
COPY --from=browser /usr/share/fonts/ /usr/share/fonts/
COPY --from=browser /etc/fonts/ /etc/fonts/
COPY --from=browser /lib/ /lib/
COPY --from=browser /usr/lib/ /usr/lib/
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    CHROME_PATH=/usr/lib/chromium/chromium-headless-shell \
    WAF_HEAL_TIMEOUT=120 \
    WAF_WAIT_MS=14000 \
    WAF_POLL_MS=250 \
    WAF_STABLE_TICKS=3 \
    PORT=8000
EXPOSE 8000
CMD ["/usr/local/bin/waf-api"]

# Optional Node implementation retained for side-by-side comparison/rollback.
FROM node:22-alpine AS api-node
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    CHROME_PATH=/usr/lib/chromium/chromium-headless-shell \
    WAF_HEAL_TIMEOUT=120 \
    WAF_WAIT_MS=14000 \
    PORT=8000
COPY --from=browser /opt/keep/chromium/ /usr/lib/chromium/
COPY --from=browser /usr/share/fonts/ /usr/share/fonts/
COPY --from=browser /etc/fonts/ /etc/fonts/
COPY --from=browser /lib/ /lib/
COPY --from=browser /usr/lib/ /usr/lib/
COPY server.js ./
EXPOSE 8000
CMD ["node", "server.js"]
