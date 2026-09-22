FROM oven/bun:1.4-alpine AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY core/package.json core/package.json
COPY warden/package.json warden/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --cwd warden build:binary

FROM alpine:3.21
# workerd needs glibc; the compat layer is what lets the pinned binary run on alpine
RUN apk add --no-cache ca-certificates libstdc++ libgcc gcompat curl \
	&& addgroup -S bastion \
	&& adduser -S -G bastion -h /var/lib/bastion bastion \
	&& mkdir -p /var/lib/bastion /etc/bastion \
	&& chown -R bastion:bastion /var/lib/bastion /etc/bastion

COPY --from=build /src/warden/dist/bastion /usr/local/bin/bastion
RUN ln -s /usr/local/bin/bastion /usr/local/bin/warden

# a container cannot give a tenant its own microVM, so the image ships `hardened` and says so
ENV BASTION_CONFIG=/etc/bastion/bastion.yml
ENV BASTION_MODE=hardened

USER bastion
WORKDIR /var/lib/bastion
EXPOSE 8080 8443 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
CMD bastion doctor --json > /dev/null || exit 1

ENTRYPOINT ["bastion"]
CMD ["serve"]
