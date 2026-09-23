#!/usr/bin/env bash
# Builds the guest root filesystem `isolated` boots: workerd, a vsock forwarder, and an init.
#
# The guest has no network interface, so every byte in or out crosses vsock. workerd cannot speak
# vsock, so socat bridges each side: the adapters are unix sockets the guest dials out from, and
# serving traffic is a vsock port bastion dials in to. The layout here has to match GUEST_LAYOUT
# and VSOCK_PORTS in core/src/isolation; a spec holds the port list against the adapter slots.
#
#     core/scripts/guest-image.sh [directory] [workerd binary]
set -euo pipefail

RIG="${1:-${HOME}/bastion-rig/fc}"
WORKERD="${2:-}"
SIZE_MB="${GUEST_IMAGE_MB:-512}"

if [ "$(uname -m)" != "x86_64" ]; then
	echo "the guest image is x86_64; this host is $(uname -m)" >&2
	exit 2
fi
if [ -z "$WORKERD" ] || [ ! -x "$WORKERD" ]; then
	echo "pass the pinned workerd binary as the second argument" >&2
	echo "  npm install --prefix /tmp/rt workerd@\$(bastion version --json | jq -r .workerd)" >&2
	exit 2
fi

mkdir -p "$RIG"
cp -f "$WORKERD" "$RIG/workerd.bin"

# the ports the guest dials out on, one per adapter slot, and the one bastion dials in on
ADAPTERS="cache:8081 kv:8082 r2:8083 queues:8084 assets:8085 sql:8086 ai:8087 vectorize:8088 email:8089 images:8090 browser:8091 analytics:8092"

cat > "$RIG/guest-init.sh" << INIT
#!/bin/sh
# pid 1 in the guest: mount what bastion handed over, bridge vsock, then run workerd
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sys /sys
/bin/busybox mount -t devtmpfs dev /dev 2>/dev/null || true
# pid 1 inherits no descriptors, so without this every failure below is a silent exit
exec > /dev/console 2>&1
set -e
# the rootfs is mounted read only on purpose, so every mountpoint is baked into the image and the
# only writable place for sockets is a tmpfs
/bin/busybox mount -t tmpfs tmpfs /run
/bin/busybox mkdir -p /run/bastion/adapters

# vdb is the tenant's storage and is the only writable drive; vdc is the config drive
/bin/busybox mount -t ext4 /dev/vdb /var/lib/bastion/storage
/bin/busybox mount -t ext4 -o ro /dev/vdc /srv/bastion

for pair in $ADAPTERS; do
  slot=\$(echo "\$pair" | /bin/busybox cut -d: -f1)
  port=\$(echo "\$pair" | /bin/busybox cut -d: -f2)
  socat UNIX-LISTEN:/run/bastion/adapters/\$slot.sock,fork,unlink-early VSOCK-CONNECT:2:\$port &
done

# bastion dials this to reach workerd; workerd binds the unix socket named in the capnp
socat VSOCK-LISTEN:8080,fork UNIX-CONNECT:/run/bastion/http.sock &

echo BASTION_GUEST_UP
exec /usr/bin/workerd serve --socket-addr=http=unix:/run/bastion/http.sock /srv/bastion/config.capnp
INIT

# debian rather than alpine because workerd is linked against glibc: under musl's loader it gets
# as far as `Error relocating` and the guest panics on a dead init. Built in a container because
# mkfs and the device nodes need privileges the rig user does not have
docker run --rm --privileged -v "$RIG":/work debian:12-slim sh -c "
	set -e
	export DEBIAN_FRONTEND=noninteractive
	apt-get update >/dev/null 2>&1
	apt-get install -y busybox-static socat e2fsprogs >/dev/null 2>&1
	mkdir -p /g/bin /g/usr/bin /g/lib /g/lib64 /g/proc /g/sys /g/dev /g/run /g/sbin
	# the drives mount here and the rootfs is read only, so these exist before it is sealed
	mkdir -p /g/srv/bastion /g/var/lib/bastion/storage
	# the kernel hands pid 1 no stdout unless /dev/console already exists in the image, and
	# devtmpfs is mounted by init, which is too late to see init's own failures
	mknod -m 600 /g/dev/console c 5 1
	mknod -m 666 /g/dev/null c 1 3
	cp /bin/busybox /g/bin/busybox
	ln -sf /bin/busybox /g/bin/sh
	cp /usr/bin/socat /g/usr/bin/socat
	cp /work/workerd.bin /g/usr/bin/workerd
	chmod +x /g/usr/bin/workerd /g/usr/bin/socat
	# every shared object each one names, plus the loader itself, or the guest dies on relocation
	for bin in /g/usr/bin/socat /g/usr/bin/workerd; do
		ldd \$bin 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if (\$i ~ /^\//) { print \$i; break } }' |
			while read -r lib; do
				mkdir -p /g\$(dirname \$lib)
				cp -Lf \$lib /g\$lib 2>/dev/null || true
			done
	done
	cp -Lf /lib64/ld-linux-x86-64.so.2 /g/lib64/ 2>/dev/null || true
	cp /work/guest-init.sh /g/sbin/init
	chmod +x /g/sbin/init
	truncate -s ${SIZE_MB}M /work/guest.ext4
	mkfs.ext4 -q -d /g -F /work/guest.ext4"

docker run --rm -v "$RIG":/work alpine:3.21 chown "$(id -u):$(id -g)" /work/guest.ext4
echo "guest image ready:"
ls -lh "$RIG/guest.ext4"
