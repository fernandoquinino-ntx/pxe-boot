'use strict';
// Network boot for Nutanix Community Edition (Phoenix installer).
//
// Why a shim is needed: the CE installer (init=/ce_installer, see livecd.sh inside its initrd)
// only looks for a block device labelled PHOENIX (a CD or USB stick) to get squashfs.img and the
// ~4.7 GB installer package. It has no network path. So we give it one: a second initrd replaces
// /ce_installer with the script below, which downloads the whole ISO into RAM, attaches it as a
// loop device (label PHOENIX, so blkid finds it) and then hands over to the original livecd.sh.
// Nothing inside the ISO or the original initrd is modified.

const SHIM = `#!/bin/sh
# PXE Lab Installer: network-boot shim for Nutanix CE (replaces the /ce_installer symlink)
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
say() { echo "[pxe] $*"; }
param() { sed -n "s/.*[ ]$1=\\\\([^ ]*\\\\).*/\\\\1/p" /proc/cmdline | head -n1; }

ISO_URL=$(param CE_ISO_URL)
ISO_SIZE=$(param CE_ISO_SIZE)

if [ -n "$ISO_URL" ]; then
  say "Network boot: loading drivers"
  . /modules.sh
  ifconfig lo 127.0.0.1 netmask 255.0.0.0 up

  say "Getting an IP address"
  GOT=""
  for try in 1 2 3 4 5 6; do
    for x in /sys/class/net/*; do
      n=\${x##*/}
      [ "$n" = "lo" ] && continue
      ifconfig "$n" up
    done
    sleep 3
    for x in /sys/class/net/*; do
      n=\${x##*/}
      [ "$n" = "lo" ] && continue
      if udhcpc -q -n -t 4 -T 3 -i "$n" -s /dhcp.sh >/dev/null 2>&1; then GOT=$n; break; fi
    done
    [ -n "$GOT" ] && break
    say "No DHCP answer yet (try $try/6)"
  done
  if [ -z "$GOT" ]; then say "ERROR: no network. Cannot load the installer."; exec sh; fi
  say "Network up on $GOT"

  mkdir -p /mnt/pxe
  SIZE_OPT=""
  [ -n "$ISO_SIZE" ] && SIZE_OPT="-o size=$((ISO_SIZE + 67108864))"
  mount -t tmpfs $SIZE_OPT tmpfs /mnt/pxe || { say "ERROR: cannot create RAM disk"; exec sh; }

  say "Downloading the installer ISO into RAM (this takes a few minutes): $ISO_URL"
  ok=""
  for try in 1 2 3; do
    wget -T 60 -O /mnt/pxe/ce.iso "$ISO_URL" && ok=1 && break
    say "Download failed (try $try/3)"
    sleep 5
  done
  [ -n "$ok" ] || { say "ERROR: download failed. Is the PXE Lab Installer server still running?"; exec sh; }
  if [ -n "$ISO_SIZE" ]; then
    GOTSZ=$(wc -c < /mnt/pxe/ce.iso)
    [ "$GOTSZ" = "$ISO_SIZE" ] || { say "ERROR: got $GOTSZ bytes, expected $ISO_SIZE"; exec sh; }
  fi

  modprobe loop 2>/dev/null; modprobe isofs 2>/dev/null; modprobe squashfs 2>/dev/null   # built into this kernel; harmless if absent
  losetup /dev/loop0 /mnt/pxe/ce.iso || { say "ERROR: cannot attach the ISO as a disk"; exec sh; }
  say "ISO attached as /dev/loop0. Starting the Nutanix installer."
fi

# Hand over to the original Nutanix script. Sourced (not exec'd) so that \$0 stays
# "ce_installer", which is how livecd.sh knows it is the Community Edition.
. /livecd.sh
`;

module.exports = { SHIM };
