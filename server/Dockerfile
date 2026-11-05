FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /lantern-dock ./cmd/lantern-dock \
    && mkdir -p /empty/data /empty/public

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /lantern-dock /lantern-dock
COPY --from=build --chown=65532:65532 /empty/ /
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/lantern-dock"]
CMD ["serve", "--public-dir=/public", "--data-dir=/data"]
