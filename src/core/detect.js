'use strict';
// Works out which Linux family an ISO belongs to and how to boot it over the network.

function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      section = m[1].toLowerCase();
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) out[`${section}.${line.slice(0, i).trim().toLowerCase()}`] = line.slice(i + 1).trim();
  }
  return out;
}

function firstMatch(iso, dir, re) {
  const hit = iso.list(dir).find((e) => !e.isDir && re.test(e.name));
  return hit ? `${dir}/${hit.name}` : null;
}

function readText(iso, p) {
  const b = iso.readFile(p, 64 * 1024);
  return b ? b.toString('utf8').replace(/\0/g, '').trim() : null;
}

/**
 * Returns { supported, family, label, kernel, initrd, mode, reason }
 *  family: ubuntu | debian-live | fedora-live | redhat-installer | proxmox | nutanix-ce
 *  kernel/initrd: paths inside the ISO
 */
function detect(iso, fallbackName = 'Linux') {
  const diskInfo = readText(iso, '/.disk/info');
  const volume = iso.volumeId || fallbackName;

  // NVIDIA Jetson installer ISO (Ubuntu Server arm64 casper layout, kernel named /casper/Image).
  // Checked against the JetPack 7.2.1 ISO (5.04 GB): the kernel has no NFIT/pmem driver, so it
  // cannot see an ISO that UEFI HTTP boot keeps in a RAM disk, and casper's url= mode would need
  // a second 5 GB copy in RAM. Neither fits an Orin Nano (4-8 GB). See docs/jetson-network-boot.md.
  if (iso.lookup('/casper/Image') && !iso.lookup('/casper/vmlinuz') && /jetson/i.test(volume + ' ' + fallbackName)) {
    // Install targets come from the ISO's own grub.cfg ("Install on NVMe / USB / microSD ...").
    const grub = readText(iso, '/boot/grub/grub.cfg') || '';
    const variants = [];
    const re = /menuentry\s+"([^"]+)"\s*\{\s*linux\s+\/casper\/Image\s+([^\n]*)/g;
    let m;
    while ((m = re.exec(grub))) {
      if (/^Install on/i.test(m[1])) variants.push({ key: variants.length ? `t${variants.length}` : 'nvme', label: m[1].replace(/\s*\(.*\)\s*$/, ''), args: m[2].trim() });
    }
    if (!variants.length) variants.push({ key: 'nvme', label: 'Install on NVMe', args: 'autoinstall fsck.mode=skip force-bootdisk=nvme0n1 clk_ignore_unused pd_ignore_unused firmware_class.path=/etc/firmware nospectre_bhb efi=runtime cloud-init=disabled' });
    // Too big for RAM (5 GB), so casper mounts the extracted tree over NFS (netboot=nfs), served by the app's NFS server.
    // Verified in QEMU arm64 with the real JetPack 7.2.1 kernel/initrd; real Orin Nano firmware untested. See docs/jetson-network-boot.md.
    return { supported: true, family: 'jetson-installer', label: `NVIDIA Jetson installer (${cleanLabel(diskInfo) || volume})`, kernel: '/casper/Image', initrd: '/casper/initrd', mode: 'nfs', needsNfs: true, variants };
  }

  // Nutanix Community Edition installer (volume label PHOENIX, has /phoenix_version).
  // Its initrd only reads squashfs.img + the ~4.7 GB installer package from a block device
  // labelled PHOENIX, so we network-boot it with a shim initrd that loads the ISO into RAM
  // and attaches it as that device (see nutanix.js). Verified against CE 2024.08.19 (AOS 6.8.1).
  if (iso.lookup('/phoenix_version') || /^phoenix$|nutanix/i.test(volume) || /nutanix|phoenix/i.test(fallbackName)) {
    const grub = readText(iso, '/EFI/BOOT/grub.cfg') || '';
    const m = /linuxefi\s+\/boot\/kernel\s+([^\n]*init=\/ce_installer[^\n]*)/.exec(grub);
    const label = cleanLabel(readText(iso, '/phoenix_version')) || volume;
    if (m && iso.lookup('/boot/kernel') && iso.lookup('/boot/initrd') && iso.lookup('/squashfs.img')) {
      return { supported: true, family: 'nutanix-ce', label: `Nutanix CE (${label})`, kernel: '/boot/kernel', initrd: '/boot/initrd', ceArgs: m[1].trim(), mode: 'ram' };
    }
    return {
      supported: false,
      family: 'nutanix',
      label,
      reason: 'This Nutanix ISO is not the Community Edition installer (no CE boot entry), so it cannot be network-booted. Write it to a USB stick instead.',
    };
  }

  // Proxmox VE / Backup Server / Mail Gateway: the installer needs the whole ISO inside its initrd
  if (iso.lookup('/boot/linux26') && iso.lookup('/boot/initrd.img') && (iso.lookup('/.pve-cd-id.txt') || iso.lookup('/proxmox') || /proxmox|pve|pbs|pmg/i.test(volume))) {
    return { supported: true, family: 'proxmox', label: cleanLabel(volume.replace(/[-_]/g, ' ')) || 'Proxmox', kernel: '/boot/linux26', initrd: '/boot/initrd.img', mode: 'ram' };
  }

  // Ubuntu and flavours (casper live system)
  if (iso.lookup('/casper')) {
    const kernel = iso.lookup('/casper/vmlinuz') ? '/casper/vmlinuz' : firstMatch(iso, '/casper', /^vmlinuz/i);
    const initrd = ['/casper/initrd', '/casper/initrd.gz', '/casper/initrd.lz', '/casper/initrd.img'].find((p) => iso.lookup(p)) || firstMatch(iso, '/casper', /^initrd/i);
    if (kernel && initrd) {
      return { supported: true, family: 'ubuntu', label: cleanLabel(diskInfo) || volume, kernel, initrd, mode: 'live' };
    }
  }

  // Debian live (live-boot)
  if (iso.lookup('/live/filesystem.squashfs')) {
    const kernel = firstMatch(iso, '/live', /^vmlinuz/i);
    const initrd = firstMatch(iso, '/live', /^initrd/i);
    if (kernel && initrd) {
      return { supported: true, family: 'debian-live', label: cleanLabel(diskInfo) || volume, kernel, initrd, squashfs: '/live/filesystem.squashfs', mode: 'live' };
    }
  }

  // Fedora / RHEL / Rocky / Alma / CentOS Stream
  if (iso.lookup('/images/pxeboot/vmlinuz')) {
    const tree = readText(iso, '/.treeinfo');
    const ini = tree ? parseIni(tree) : {};
    const name = ini['release.name'] || ini['general.family'] || ini['product.name'] || volume;
    const version = ini['release.version'] || ini['general.version'] || ini['product.version'] || '';
    const label = `${name} ${version}`.trim();
    const live = ['/LiveOS/squashfs.img', '/LiveOS/rootfs.img'].find((p) => iso.lookup(p));
    const base = { supported: true, kernel: '/images/pxeboot/vmlinuz', initrd: '/images/pxeboot/initrd.img' };
    if (live) return { ...base, family: 'fedora-live', label: `${label} (Live)`, liveImage: live, mode: 'live' };
    return { ...base, family: 'redhat-installer', label: `${label} (Installer)`, mode: 'installer' };
  }

  // Debian netinst / DVD: its installer expects a CD drive
  if (iso.lookup('/install.amd') || iso.lookup('/install.a64')) {
    return {
      supported: false,
      family: 'debian-installer',
      label: cleanLabel(diskInfo) || volume,
      reason: 'Debian "netinst"/DVD ISOs can only install from a CD. Use the built-in "Debian network installer" entry, or a Debian *live* ISO.',
    };
  }

  if (iso.lookup('/sources/install.wim') || iso.lookup('/sources/install.esd')) {
    return { supported: false, family: 'windows', label: volume, reason: 'Windows ISOs are not supported (Linux only).' };
  }

  return { supported: false, family: 'unknown', label: volume, reason: 'Unrecognised ISO. Supported: Ubuntu, Debian live, Fedora, Rocky, AlmaLinux, CentOS Stream, RHEL.' };
}

function cleanLabel(info) {
  if (!info) return null;
  return info.split('\n')[0].replace(/\s*-\s*Release\s+\S+/i, '').replace(/\s+\(\d{8}(\.\d+)?\)\s*$/, '').trim() || null;
}

/** Kernel command line for an image, given the server's base URL. */
function bootArgs(image, base, variantIdx = 0) {
  const nfsHost = (/^https?:\/\/([^:/]+)/.exec(base) || [])[1] || '';
  const isoUrl = `${base}/isofile/${image.id}.iso`;
  const tree = `${base}/iso/${image.id}`;
  switch (image.family) {
    case 'ubuntu':
      // casper downloads the whole ISO into RAM: client needs RAM > ISO size + ~1 GB
      return `ip=dhcp url=${isoUrl} cloud-config-url=/dev/null`;
    case 'debian-live':
      return `boot=live components fetch=${tree}${image.squashfs}`;
    case 'fedora-live':
      return `root=live:${tree}${image.liveImage} rd.live.image rd.neednet=1 ip=dhcp`;
    case 'redhat-installer':
      return `inst.repo=${tree}/ ip=dhcp`;
    case 'jetson-installer':
      return `${(image.variants && image.variants[variantIdx || 0] || {}).args || ''} ip=dhcp netboot=nfs nfsroot=${nfsHost}:/iso/${image.id}`;
    case 'nutanix-ce':
      // original grub.cfg arguments, plus where the shim downloads the ISO from
      return `${image.ceArgs} CE_ISO_URL=${isoUrl} CE_ISO_SIZE=${image.size}`;
    case 'proxmox':
      // the installer finds the ISO as /proxmox.iso inside the (extra) initrd, which lives in RAM
      return 'ramdisk_size=16777216 rw quiet splash=silent';
    default:
      return '';
  }
}

/** Extra initrd files an image needs, as [{ name, url }]. */
function extraInitrds(image, base) {
  if (image.family === 'proxmox') return [{ name: 'proxmox.iso', url: `${base}/pveiso/${image.id}.cpio` }];
  if (image.family === 'nutanix-ce') return [{ name: 'ce-pxe.cpio', url: `${base}/ceshim/${image.id}.cpio` }];
  return [];
}

module.exports = { detect, bootArgs, extraInitrds, parseIni, cleanLabel };
