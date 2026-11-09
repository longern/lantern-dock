FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.24 AS build
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /lantern-dock ./cmd/lantern-dock

FROM build AS test
RUN apk add --no-cache build-base ffmpeg exiftool
COPY --from=test-fixtures / /test/fixtures/
RUN go vet ./... && go test -race ./...

FROM alpine:3.24
RUN apk add --no-cache ca-certificates setpriv ffmpeg exiftool \
    && addgroup -g 1000 lantern \
    && adduser -D -H -u 1000 -G lantern lantern \
    && mkdir -p /data /public /usr/local/libexec \
    && ln -s /usr/local/bin/docker-entrypoint.sh /lantern-dock
COPY --from=build /lantern-dock /usr/local/libexec/lantern-dock
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV PUID=1000 PGID=1000
USER 0:0
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve", "--public-dir=/public", "--data-dir=/data"]
