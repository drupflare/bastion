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

echo "hypervisor and kernel ready in ${RIG}:"
ls -lh firecracker jailer "$KERNEL"

# the rootfs carries the pinned workerd, so it is built separately against a binary this script
# has no way to choose. Both microVM lanes boot the same image an operator would run
if [ -e guest.ext4 ]; then
	ls -lh guest.ext4
else
	echo
	echo "next, build the guest image against the pinned runtime:"
	echo "  core/scripts/guest-image.sh ${RIG} /path/to/workerd"
fi
