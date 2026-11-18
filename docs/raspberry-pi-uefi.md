# Network-booting Raspberry Pi blades with PXE Lab Installer

PXE Lab Installer boots machines with **iPXE over UEFI** (or BIOS). A Raspberry Pi has neither out
of the box: its own boot ROM can only netboot a Pi-specific kernel over TFTP, not the iPXE menu.
So each blade needs **UEFI firmware** first. This is a one-time job per blade.

> These steps follow the upstream projects' documentation. They have not been tested on your
> hardware, so check each project's README for your exact Pi model before you start.

## 1. Find out which Pi you have
Your blades' network cards start with `D8:3A:DD`, which is a newer Raspberry Pi Trading prefix
(Pi 5 / newer Pi 4 or CM4 boards). Check the model on the board label or with
`cat /proc/device-tree/model` from any OS running on it.

## 2. Install UEFI firmware (SD card, once per blade)
| Model | Firmware | Notes |
|---|---|---|
| Raspberry Pi 4 / CM4 / Pi 400 | [pftf/RPi4](https://github.com/pftf/RPi4) | Unzip the release onto a FAT32 SD card, insert, power on. |
| Raspberry Pi 3 | [pftf/RPi3](https://github.com/pftf/RPi3) | Same procedure. |
| Raspberry Pi 5 | Community EDK2 port (search "rpi5 UEFI edk2") | Experimental. Check its network-boot status before buying more time on it. |

Steps for the Pi 4:
1. Format an SD card as **FAT32** and unzip the latest `RPi4_UEFI_Firmware_*.zip` onto it.
2. Put the card in the blade and power it on. Press **Esc** at the logo to open the firmware menu.
3. Under **Device Manager → Raspberry Pi Configuration → Advanced**, set the system table to
   **ACPI + Device Tree** only if the OS you install needs it (Ubuntu and Debian work with the default).
4. Under **Boot Manager**, pick **UEFI PXEv4** to network-boot. Or open **Boot Maintenance
   Manager → Boot Options → Change Boot Order** and put the network entry first.

## 3. Make sure the router hands out the PXE settings
Run PXE Lab Installer (step 1 → *Apply to router*) so the MikroTik points `next-server` at the
computer running the app. The app answers ARM64 UEFI clients with `ipxe-arm64.efi`.

## 4. Boot
Start the server (step 3 in the app), power on the blade, and choose **UEFI PXEv4**. You should see
the iPXE menu within a few seconds, and the blade appear under *Machines that asked to boot*.

## Things to know
- **Secure Boot** stays off (the Pi firmware ships with it off).
- Only **ARM64** images work on a Pi. Use arm64 ISOs (Ubuntu Server arm64, Debian arm64 netinst via the
  built-in entry, Fedora aarch64, Rocky/Alma aarch64).
- **Ubuntu and Proxmox** load the whole ISO into RAM. A Pi with 4 GB cannot load a 2.7 GB Ubuntu ISO
  comfortably; use an 8 GB blade or the built-in **Debian network installer**, which downloads
  only what it needs.
- Proxmox VE is **x86-64 only**. It will not run on a Pi.
- The PXE firmware needs a wired link: connect the blade to a router port in the lab
  (ether2-ether5), not Wi-Fi.
