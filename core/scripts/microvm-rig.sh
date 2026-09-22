#!/usr/bin/env bash
# Builds what the `isolated` lane needs: a hypervisor, a guest kernel and a root filesystem.
#
# The lane boots a real guest, so it needs real artifacts. None of them are committed: the kernel
# is 40 MiB and the hypervisor is a release binary, and a repository is not a mirror. Run this
# once per machine, then `REQUIRE_KVM=1 bun run test:e2e`.
#
#     core/scripts/microvm-rig.sh [directory]     # default ~/bastion-rig/fc
set -euo pipefail

# above the CVE-2026-5747 / CVE-2026-1386 floor the config validator enforces
FIRECRACKER_VERSION="v1.17.0"
KERNEL="vmlinux-6.1.128"
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/x86_64/${KERNEL}"
RIG="${1:-${HOME}/bastion-rig/fc}"

if [ "$(uname -m)" != "x86_64" ]; then
	echo "the rig builds x86_64 artifacts; this host is $(uname -m)" >&2
	exit 2
fi
if [ ! -e /dev/kvm ]; then
	echo "/dev/kvm is absent, so no guest can boot here" >&2
	exit 2
fi

mkdir -p "$RIG"
cd "$RIG"

if [ ! -e firecracker ]; then
	release="firecracker-${FIRECRACKER_VERSION}-x86_64.tgz"
	curl -sSL -o "$release" \
		"https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${release}"
	tar xzf "$release"
	# the jailer names the chroot after what --exec-file RESOLVES to, so these are copies rather
	# than symlinks; a symlink here puts the chroot under the versioned name instead
	cp "release-${FIRECRACKER_VERSION}-x86_64/firecracker-${FIRECRACKER_VERSION}-x86_64" firecracker
	cp "release-${FIRECRACKER_VERSION}-x86_64/jailer-${FIRECRACKER_VERSION}-x86_64" jailer
	chmod +x firecracker jailer
	rm -f "$release"
fi

[ -e "$KERNEL" ] || curl -sSL -o "$KERNEL" "$KERNEL_URL"

# a guest rootfs whose init prints the marker the lane greps for and then powers the VM off, so a
# boot that hangs fails the lane instead of timing the suite out. Built in a container because a
# loop mount and mkfs need privileges the rig user does not have and should not be given
if [ ! -e guest.ext4 ]; then
	docker run --rm --privileged -v "$PWD":/work alpine:3.21 sh -c '
		apk add --no-cache busybox-static e2fsprogs >/dev/null 2>&1
		mkdir -p /g/sbin /g/bin /g/proc /g/dev
		cp /bin/busybox.static /g/bin/busybox
		ln -sf /bin/busybox /g/bin/sh
		printf "#!/bin/sh\n/bin/busybox mount -t proc proc /proc\necho BASTION_GUEST_UP\n/bin/busybox sync\necho o > /proc/sysrq-trigger\n" > /g/sbin/init
		chmod +x /g/sbin/init
		truncate -s 48M /work/guest.ext4
		mkfs.ext4 -q -d /g -F /work/guest.ext4'
	docker run --rm -v "$PWD":/work alpine:3.21 chown "$(id -u):$(id -g)" /work/guest.ext4
fi

echo "microVM rig ready in ${RIG}:"
ls -lh firecracker jailer "$KERNEL" guest.ext4
