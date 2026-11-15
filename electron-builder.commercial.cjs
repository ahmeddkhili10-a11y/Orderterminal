// electron-builder settings for the commercial edition (scripts/dist-commercial.mjs):
// the same app as package.json's "build", with its own identity, output folder,
// installer names and the licence agreement in the Windows installer.
const base = require('./package.json').build;
const { version } = require('./package.json');

module.exports = {
  ...base,
  appId: 'com.quincygininda.novusordo.terminal',
  productName: 'Novus Ordo',
  copyright: `Copyright © ${new Date().getFullYear()} Quincy Gininda. All rights reserved.`,
  directories: { ...base.directories, output: 'release/commercial' },
  extraMetadata: {
    description: 'Novus Ordo — the professional crypto trading terminal, designed and constructed by Quincy Gininda.',
  },
  win: {
    ...base.win,
    target: ['nsis', 'portable'],
    artifactName: `NovusOrdo-${version}-Windows-\${arch}.\${ext}`,
  },
  nsis: {
    ...base.nsis,
    artifactName: `NovusOrdo-${version}-Windows-Setup.exe`,
    license: 'build/EULA.txt',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
  },
  portable: { artifactName: `NovusOrdo-${version}-Windows-Portable.exe` },
  mac: {
    ...base.mac,
    target: ['dir'],
    category: 'public.app-category.finance',
    icon: 'build/icon.png',
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    ...base.linux,
    target: ['AppImage', 'deb'],
    category: 'Finance',
    icon: 'build/icon.png',
    maintainer: 'Quincy Gininda',
    vendor: 'Quincy Gininda',
    synopsis: 'The professional crypto trading terminal',
    description: 'Novus Ordo — order flow, quant desk, strategy lab, edge finder and an autonomous crypto swarm, designed and constructed by Quincy Gininda.',
    artifactName: `NovusOrdo-${version}-Linux-\${arch}.\${ext}`,
  },
  deb: { packageName: 'novus-ordo' },
};
