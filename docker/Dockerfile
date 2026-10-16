FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY core/package.json core/package.json
COPY warden/package.json warden/package.json
COPY dashboard/package.json dashboard/package.json
RUN bun install --frozen-lockfile
COPY . .
# the root `build:binary`, not warden's: the console is embedded as a generated module and warden's
# own script compiles the cli alone. The grep runs before the chain restores the empty form
RUN bun run build:dashboard \
	&& grep -q index.html warden/src/dashboard-assets.ts \
	&& bun run --cwd warden build:binary

FROM debian:bookworm-slim
# workerd 1.20260828.1 needs glibc symbols (`_dl_find_object`, `sigdescr_np`, `fcntl64`) that
# alpine's gcompat does not provide: the pinned binary exited 127 on every start. The build stage is
# glibc too, since a compiled bun binary is linked against the libc of the image that built it
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl iproute2 \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --system bastion \
	&& useradd --system --gid bastion --home-dir /var/lib/bastion bastion \
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
