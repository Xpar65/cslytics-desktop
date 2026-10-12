// @ts-check
/**
 * The Windows installer and the update feed every installed copy reads (desktop release plan §4).
 *
 * JavaScript rather than YAML because signing depends on the environment: `pnpm package:desktop`
 * builds an unsigned installer for this machine, and `pnpm release:desktop` refuses to run without
 * the certificate, whose thumbprint and subject arrive as
 *
 *   CSLYTICS_SIGN_SHA1       the YubiKey certificate's SHA-1 thumbprint (`certutil -scinfo`)
 *   CSLYTICS_PUBLISHER_NAME  its subject, exactly as the certificate spells it
 *
 * Every value below except the signing pair is permanent once a public build ships (D1, D3, D5):
 * `appId` and `productName` locate the install and the profile, `publish.url` is written into each
 * copy's `app-update.yml` as the only place it will ever look for updates, and `publisherName` is
 * the only signer it will ever accept an update from. `src/main/release/identity.ts` holds the same
 * values for the app itself, and `tests/unit/desktop-packaging.test.ts` keeps the two equal.
 *
 * Two installers come out of one build (desktop release plan §4). The web installer is the small
 * download the website offers; it fetches the app package from the feed folder at install time, and
 * the patched template refuses a package whose SHA-512 is not the one it was built with
 * (`patches/app-builder-lib-web-package-hash.patch`). The full installer is the offline download and the only file
 * `latest.yml` names: an update through the web installer would have its signature checked on the
 * small installer alone, with the package checked only against the feed the same host serves.
 */
const thumbprint = process.env.CSLYTICS_SIGN_SHA1?.trim() || null;
const publisher = process.env.CSLYTICS_PUBLISHER_NAME?.trim() || null;
if (thumbprint && !publisher) throw new Error('CSLYTICS_PUBLISHER_NAME is required with CSLYTICS_SIGN_SHA1: installed copies verify updates against it');

const feedUrl = 'https://downloads.cslytics.com/win';

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.cslytics.desktop',
  productName: 'CSlytics',
  copyright: 'Copyright © Liam Cunneen',
  // `CSLYTICS_PACKAGE_DIR` moves the output out of the repository. With the workspace open in an
  // editor, a folder inside it cannot be packaged into: something indexing the workspace (Cursor, or Windows Search
  // over Documents) opens the freshly extracted `default_app.asar` and holds it, and electron-builder
  // fails renaming `win-unpacked.tmp` with EPERM. The scripts read the same variable.
  directories: { output: process.env.CSLYTICS_PACKAGE_DIR?.trim() || 'dist' },
  // The build output and the runtime icon; the manifest comes on its own. Dependencies are the
  // manifest's `dependencies`, which are exactly what main loads at runtime (D10).
  files: ['out/**/*', 'resources/**/*'],
  // Names the packaged app `CSlytics` without giving the development manifest a product name, which
  // would move the development profile away from the record already in it (D2). `name` sets the
  // folder downloaded updates wait in, `%LOCALAPPDATA%\cslytics-desktop-updater`, rather than one
  // derived from the scoped workspace name.
  extraMetadata: { name: 'cslytics-desktop', productName: 'CSlytics' },
  // Nothing here is native: SQLite is `node:sqlite`, built into Electron's Node.
  npmRebuild: false,
  asar: true,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'nsis-web', arch: ['x64'] }],
    icon: 'resources/icon.png',
    signExecutable: Boolean(thumbprint),
    ...(thumbprint ? {
      signtoolOptions: {
        certificateSha1: thumbprint,
        publisherName: publisher,
        rfc3161TimeStampServer: 'http://ts.ssl.com',
        signingHashAlgorithms: ['sha256']
      }
    } : {}),
    // Each installed copy refuses a downloaded update whose Authenticode signer is not the
    // publisher above. An unsigned build has no publisher, so it verifies nothing, which is why
    // an unsigned build is never published.
    verifyUpdateCodeSignature: true
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: 'CSlytics-Setup-${version}.${ext}',
    shortcutName: 'CSlytics',
    differentialPackage: true,
    // The trading record and saved logins outlive an uninstall; removing them is the person's call.
    deleteAppDataOnUninstall: false
  },
  // Inherits everything under `nsis` above. Its own publish entry gives it the package URL (the feed
  // folder plus the package's name) and writes no update info: without it, electron-builder merges
  // both installers into one `latest.yml` and the web installer leads it.
  nsisWeb: {
    artifactName: 'CSlytics-Web-Setup-${version}.${ext}',
    publish: [{ provider: 'generic', url: feedUrl, publishAutoUpdate: false }]
  },
  publish: [{ provider: 'generic', url: feedUrl, channel: 'latest' }]
};

export default config;
