'use strict';
// Builds the iPXE boot menu shown on every machine that boots from the network.

const { bootArgs, extraInitrds } = require('./detect');

const BUILTINS = [
  {
    id: 'debian-netinst',
    label: 'Debian stable - network installer (downloads from deb.debian.org)',
    script: (base) =>
      [
        'iseq ${buildarch} arm64 && set darch arm64 || set darch amd64',
        'set dmirror http://deb.debian.org/debian/dists/stable/main/installer-${darch}/current/images/netboot/debian-installer/${darch}',
        'kernel ${dmirror}/linux initrd=initrd.gz',
        'initrd --name initrd.gz ${dmirror}/initrd.gz',
        'boot',
      ].join('\n'),
  },
  {
    id: 'netbootxyz',
    label: 'netboot.xyz - online menu with dozens of distros',
    script: () => 'chain --autofree https://boot.netboot.xyz || goto failed',
  },
];

function safeText(s) {
  return String(s).replace(/[${}\r\n]/g, '').slice(0, 70);
}

/**
 * images: [{ id, label, family, kernel, initrd, ... , status: 'ready' }]
 * opts: { base, builtins: { 'debian-netinst': true, netbootxyz: true }, timeoutSec }
 */
function buildMenu(images, opts) {
  const { base, builtins = {}, timeoutSec = 60, title = 'PXE Lab Installer' } = opts;
  const ready = images.filter((i) => i.status === 'ready' && i.supported);
  const extras = BUILTINS.filter((b) => builtins[b.id] !== false);
  const lines = ['#!ipxe', '', `set server ${base}`, '', ':start', `menu ${safeText(title)} - choose what to install`];

  if (ready.length) {
    lines.push('item --gap --             ------------ Your images ------------');
    for (const img of ready) lines.push(`item img-${img.id} ${safeText(img.label)}`);
  }
  if (extras.length) {
    lines.push('item --gap --             ------------ Online installers ------------');
    for (const b of extras) lines.push(`item ${b.id} ${safeText(b.label)}`);
  }
  lines.push('item --gap --             ------------ Other ------------');
  lines.push('item local Boot from local disk');
  lines.push('item shell iPXE shell');
  lines.push('item reboot Reboot');
  lines.push(`choose --default local --timeout ${timeoutSec * 1000} target && goto \${target} || goto local`);
  lines.push('');

  for (const img of ready) {
    const k = `\${server}/iso/${img.id}${img.kernel}`;
    const i = `\${server}/iso/${img.id}${img.initrd}`;
    const args = bootArgs(img, base);
    const extra = extraInitrds(img, base).map((x) => `initrd --name ${x.name} ${x.url} /${x.name} || goto failed`);
    const note = img.family === 'proxmox' ? ['echo The whole ISO is loaded into RAM: this machine needs more RAM than the ISO size + 2 GB.'] : [];
    lines.push(`:img-${img.id}`, `echo Loading ${safeText(img.label)} ...`, ...note, `kernel ${k} initrd=initrd ${args} || goto failed`, `initrd --name initrd ${i} || goto failed`, ...extra, 'boot || goto failed', '');
  }
  for (const b of extras) lines.push(`:${b.id}`, b.script(base), '');

  lines.push(
    ':local',
    'echo Booting from local disk...',
    'exit 1',
    '',
    ':shell',
    'echo Type "exit" to return to the menu',
    'shell',
    'goto start',
    '',
    ':reboot',
    'reboot',
    '',
    ':failed',
    'echo Boot failed. Returning to the menu in 10 seconds...',
    'sleep 10',
    'goto start',
    ''
  );
  return lines.join('\n');
}

module.exports = { buildMenu, BUILTINS };
