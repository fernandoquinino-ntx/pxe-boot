# PXE Lab Installer

A desktop app for macOS and Windows that turns your computer into a network-install server for your lab.

1. **Connect your MikroTik.** Enter the router's IP, username and password. The app reserves a fixed IP for this computer, outside the range the router hands out, and points the router's DHCP `next-server` at it.
2. **Add Linux images.** Paste an ISO download link, or pick an ISO file. The app downloads it, works out which distro it is and adds it to the boot menu. You don't need to unpack anything.
3. **Start the server.** Turn on a lab machine and choose *Network boot / PXE*. A menu appears with every image, plus the Debian network installer and netboot.xyz.

## Build and run

You need [Node.js 20 or newer](https://nodejs.org).

```bash
npm install          # downloads Electron and electron-builder
npm start            # run the app
npm test             # run the tests

npm run dist:mac     # → dist/PXE Lab Installer-1.0.0-arm64.dmg (and x64)
npm run dist:win     # → dist/PXE Lab Installer Setup 1.0.0.exe
```

Build the macOS version on a Mac. You can build the Windows version on Windows, or on a Mac that has Wine.

The apps aren't code-signed. On macOS, right-click the app → **Open** the first time. On Windows, click **More info → Run anyway**.

## Supported images

| Distro | What the app looks for in the ISO | How it boots |
|---|---|---|
| Ubuntu Server / Desktop (and flavours) | `casper/vmlinuz`, `casper/initrd` | `url=` loads the whole ISO into RAM |
| Debian **live** ISOs | `live/filesystem.squashfs` | `boot=live fetch=` |
| Fedora Workstation/Spins (live) | `images/pxeboot` + `LiveOS/squashfs.img` | `root=live:` |
| Fedora Server/Everything, Rocky, AlmaLinux, CentOS Stream, RHEL | `images/pxeboot` + `.treeinfo` | Anaconda with `inst.repo=` |
| Proxmox VE / Backup Server / Mail Gateway (x86-64 only) | `boot/linux26` + `boot/initrd.img` | ISO streamed as a second initrd (`/proxmox.iso`), `ramdisk_size=16777216`. Needs RAM > ISO size + ~2 GB |
| Nutanix CE (**experimental**) | `boot/kernel` + `boot/initrd` + shim initrd | The CE installer only reads a disc labelled `PHOENIX`, so a small extra initrd downloads the whole 7 GB ISO into RAM and attaches it as that disc. Needs 32 GB RAM. Boot-tested in QEMU with the real kernel/initrd/root image: the installer found and mounted the ISO. The 4.7 GB AOS package step and real hardware are untested |

NVIDIA Jetson installer ISOs are recognised but **not supported** (5 GB; won't fit a Jetson's RAM): see [docs/jetson-network-boot.md](docs/jetson-network-boot.md).

Raspberry Pi blades need UEFI firmware first: see [docs/raspberry-pi-uefi.md](docs/raspberry-pi-uefi.md).
| Debian stable (built-in entry) | — | Official netboot installer from deb.debian.org |
| netboot.xyz (built-in entry) | — | Online menu with dozens of distros |

Debian *netinst*/DVD ISOs are rejected with a clear message: their installer can only install from a CD. Use the built-in Debian entry instead.

## How it works

```
Lab machine ── DHCP ──▶ MikroTik           (gets its IP address as usual)
     │      ── PXE ───▶ this app :67/4011  (proxy-DHCP: "boot ipxe.efi / undionly.kpxe")
     │      ── TFTP ──▶ this app :69       (iPXE loader)
     └───── HTTP ─────▶ this app :8080     (/boot.ipxe menu, kernel, initrd, ISO contents)
```

* **Proxy-DHCP** never hands out addresses; the MikroTik keeps doing that. It only answers PXE clients, and picks the boot file by architecture: BIOS → `undionly.kpxe`, UEFI x64 → `ipxe.efi`, UEFI ARM64 → `ipxe-arm64.efi`, iPXE → `http://…/boot.ipxe`. This is needed because RouterOS 6 can't send different boot files to BIOS and UEFI machines.
* **iPXE loaders** are downloaded from boot.ipxe.org the first time you start the server. You can also import them under *Boot files & troubleshooting*.
* **ISO contents** are read straight from the downloaded `.iso`. The app includes an ISO 9660 reader that supports Rock Ridge, Joliet and files over 4 GB.
* **MikroTik** is reached through the RouterOS API on port 8728, the `api` service under *IP → Services*. It's on by default in RouterOS 6.

Router changes made by the app:

```
/ip dhcp-server lease make-static / set address=<free IP outside the pool> comment=pxe-server
/ip dhcp-server network set next-server=<that IP>
```

To undo them, delete the `pxe-server` lease and run `/ip dhcp-server network unset 0 value-name=next-server`.

## Things to know

* **Secure Boot must be off** on target machines, because the iPXE loader from boot.ipxe.org isn't signed.
* **Ubuntu loads the full ISO into RAM.** The target machine needs more RAM than the ISO size plus about 1 GB.
* **Raspberry Pi** (for example Pi 5 blades) don't use PC-style PXE. Flash UEFI firmware (pftf/RPi5) to an SD card first, then they boot `ipxe-arm64.efi`. Use arm64 ISOs for them.
* **Ports:** UDP 67, 69, 4011 and TCP 8080 (configurable). No other DHCP/PXE server can run on the same computer, and that includes macOS Internet Sharing. Allow the app through the firewall when asked.
* The computer running the app must be **on the lab LAN** (same network as the machines that boot).

## Project layout

```
src/main.js, src/preload.js      Electron main process + secure bridge
src/renderer/                    UI (index.html, styles.css, app.js)
src/core/proxydhcp.js            Proxy-DHCP (PXE) server
src/core/tftp.js                 TFTP server (blksize/tsize/timeout)
src/core/httpserver.js           HTTP server with Range support
src/core/iso9660.js              ISO reader (Rock Ridge / Joliet / multi-extent)
src/core/detect.js               Distro detection + kernel command lines
src/core/ipxe-menu.js            iPXE menu generator
src/core/routeros.js             RouterOS API client
src/core/router-setup.js         Reservation + next-server planning/applying
src/core/pxe-service.js          Image library, downloads, server lifecycle
test/                            node:test suites (ISO, DHCP, TFTP, HTTP, RouterOS mock, end-to-end)
```
