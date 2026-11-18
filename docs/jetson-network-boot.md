# Network-installing NVIDIA Jetson boards: research findings

**Short answer:** for a Jetson Orin Nano (4 or 8 GB) the PXE Lab Installer cannot install the
JetPack installer ISO over the network today. Use the USB stick (or the Jetson Flasher app).
The original Jetson Nano cannot network-boot with stock firmware at all.

Findings come from two parts: inspecting the real **JetPack 7.2.1 installer ISO**
(`jetsoninstaller-r39.2.1`, 5,035,601,920 bytes, Ubuntu Server 24.04 arm64) and its kernel, and reading
NVIDIA's docs, forum threads and the upstream EDK2 source. Nothing here was run on a Jetson.

## Checked by inspecting the ISO and EDK2 source
- Casper layout: kernel `/casper/Image` (arm64 EFI-stub, 6.8.12-tegra), initrd `/casper/initrd`
  (has `r8168`, `nvethernet`, `atlantic` NIC drivers, `nfsmount`, `wget`). The boot menu entries
  (NVMe, microSD, USB) pass `autoinstall force-bootdisk=...`. No `url=` in the menu.
- The installer needs the **whole ISO tree** (installer squashfs 682 MB, system squashfs, offline `/pool`).
- Casper's `url=*.iso` downloads the entire ISO into RAM: more than 5 GB, plus the running system.
  Impossible on 4 GB, doubtful on 8 GB. (This is also the existing Ubuntu entry's mode, so it must not be used for Jetson.)
- Casper also supports `netboot=nfs nfsroot=host:/path` (the path must hold the extracted ISO tree).
  This avoids RAM, but needs an NFS server. The app has none.
- **UEFI HTTP boot of the ISO** (what the Jetson Flasher 2.1.0 offers): EDK2's HttpBootDxe accepts a
  DHCP offer with option 60 `HTTPClient...` and option 67 URL (proxy offers are allowed), detects `.iso`,
  and loads the whole file into a reserved, contiguous, 2 MB-aligned RAM disk, then boots the ISO's El Torito
  EFI image (the ISO has one). **But** the installer kernel has `CONFIG_ACPI_NFIT` and `LIBNVDIMM`
  disabled, so after boot Linux cannot see that RAM disk and casper would report no medium.
  It also needs a 5 GB contiguous hole in roughly 7.4 GB of usable RAM.

## From documentation and forums only (not verified)
- NVIDIA validates only **UEFI PXE with its signed GRUB** (`grubnetaa64.efi.signed`, TFTP, optional NFS rootfs).
  iPXE is "not supported/verified on Jetson"; U-Boot is unsupported.
  [UEFI docs](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/SD/Bootloader/UEFI.html),
  [forum: PXE boot for Orin NX](https://forums.developer.nvidia.com/t/pxe-boot-for-orin-nx/363775),
  [forum: network boot support](https://forums.developer.nvidia.com/t/inquiry-regarding-uefi-network-boot-support-http-pxe-for-jetson-platforms/366876).
- HTTP boot has no NVIDIA document; one user reached only a GRUB prompt
  ([forum](https://forums.developer.nvidia.com/t/http-boot-on-jetpack-6-2/338352)); an Orin Nano 8 GB booted a small
  NixOS ISO over HTTP but then needed USB ([issue](https://github.com/anduril/jetpack-nixos/issues/113)).
- A user who PXE-installed to NVMe on an Orin Nano ended at a UEFI shell
  ([forum](https://forums.developer.nvidia.com/t/orin-nano-pxe-question/300603)).
- Original Jetson Nano (Tegra210): CBoot + U-Boot, no UEFI. Network boot needs a rebuilt U-Boot flashed over USB recovery
  ([forum](https://forums.developer.nvidia.com/t/network-boot/72354)).

## Not known
- Whether the Orin Nano's Realtek NIC works in UEFI PXE/HTTP boot, whether the firmware accepts proxy-DHCP,
  whether `ipxe-arm64.efi` runs on it, and whether a manually entered Boot URI persists.

## Ideas, in order of effort (all need a real board to test)
1. **Proxy-DHCP answer for `HTTPClient`** (option 60 `HTTPClient`, option 67 `http://<ip>:8080/isofile/<id>.iso`, arch 19)
   in `src/core/proxydhcp.js`. Only useful together with 2 or 3, because the ISO alone does not finish installing.
2. **NFS-root install**: serve the extracted ISO over NFS (host `nfsd` on macOS) and boot `Image` + `initrd` with
   `netboot=nfs nfsroot=...`. A built-in NFS server would be a large new component.
3. **Boot a stock arm64 netboot/live image over PXE, then write NVIDIA's image to the NVMe.** Stock Ubuntu kernels lack
   the Tegra drivers, so this is unproven.

For a real install today: USB stick, SDK Manager recovery flashing, or the Jetson Flasher.
