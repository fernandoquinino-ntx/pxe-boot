# Changelog

All notable changes to PXE Lab Installer. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning: [Semantic Versioning](https://semver.org/). A released version is never changed: fixes ship as a new version.

## [1.1.0] - 2026-11-18

### Added
- Quick download list: looks up the latest Ubuntu Server, Debian Live, Fedora Workstation and Proxmox VE ISO on the vendor mirrors, with pinned links for Rocky, AlmaLinux, CentOS Stream and Nutanix CE, and one-click download.
- Proxmox VE network boot (ISO streamed as a second initrd).
- Nutanix CE network boot via a shim initrd (experimental, needs about 32 GB RAM; verified in QEMU, not on real hardware).
- NVIDIA Jetson (Orin Nano) installer network boot through a built-in read-only NFSv3 server (experimental; verified in QEMU arm64, not on a real Jetson).
- Raspberry Pi UEFI guide and Jetson network-boot research notes in `docs/`.
- UI regression test (Playwright, skipped if unavailable).

### Changed
- Help text lists all supported image types.
- Releases are immutable: the pipeline refuses to overwrite an existing release and takes the notes from this file.

### Fixed
- Proxy-DHCP replies to loopback clients on macOS (tests hung on macOS CI).
- iPXE wrapped extra initrds in a second cpio header.

## [1.0.0] - 2026-11-18

### Added
- First release: MikroTik setup, ISO library, proxy-DHCP/TFTP/HTTP iPXE boot server, Ubuntu / Debian Live / Fedora / Rocky / AlmaLinux / CentOS Stream images, macOS and Windows installers.
