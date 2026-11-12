#!/usr/bin/env node
'use strict';
/**
 * scripts/install-gitleaks.cjs
 *
 * Downloads the gitleaks binary from GitHub releases and places it at
 * node_modules/.bin/gitleaks for use in npm scripts.
 *
 * Pinned to a specific version to avoid supply chain drift.
 * Exits 0 in ALL cases — never blocks npm install.
 *
 * Usage:
 *   node scripts/install-gitleaks.cjs
 *   (also hooked via postinstall in package.json if desired)
 */

const { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync } = require('fs');
const { execSync, execFileSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');

const GITLEAKS_VERSION = 'v8.18.4';

const INSTALL_PATH = path.resolve(__dirname, '..', 'node_modules', '.bin', 'gitleaks');
const TMP_DIR = os.tmpdir();

/**
 * Resolve the GitHub releases asset for an OS/arch.
 *
 * Phase 88 plan 88-15: this used to return `null` on Windows, which made the
 * CALLER behave as if gitleaks were merely unavailable — a silent absence that
 * reads as a clean scan. It now returns a TYPED result, and an unsupported
 * platform says so with the platform and architecture named.
 *
 * Asset names verified against the pinned release's real asset list
 * (`gh api /repos/gitleaks/gitleaks/releases/tags/v8.18.4`): the Windows
 * assets are `_windows_x64.zip`, `_windows_x32.zip`, `_windows_armv6.zip` and
 * `_windows_armv7.zip` — a ZIP, not a tarball, and there is NO windows arm64
 * build, so win32/arm64 is an explicit unsupported result rather than a guess.
 *
 * @param {string} [platform=process.platform]
 * @param {string} [arch=process.arch]
 * @returns {{supported: true, asset: string, format: 'tar.gz'|'zip', member: string}
 *          |{supported: false, reason: string, platform: string, arch: string}}
 */
function resolveAssetName(platform = process.platform, arch = process.arch) {
  const v = GITLEAKS_VERSION.replace('v', '');
  const tar = (name) => ({ supported: true, asset: name, format: 'tar.gz', member: 'gitleaks' });
  const zip = (name) => ({ supported: true, asset: name, format: 'zip', member: 'gitleaks.exe' });

  if (platform === 'linux' && arch === 'x64') return tar(`gitleaks_${v}_linux_x64.tar.gz`);
  if (platform === 'linux' && arch === 'arm64') return tar(`gitleaks_${v}_linux_arm64.tar.gz`);
  if (platform === 'darwin' && arch === 'x64') return tar(`gitleaks_${v}_darwin_x64.tar.gz`);
  if (platform === 'darwin' && arch === 'arm64') return tar(`gitleaks_${v}_darwin_arm64.tar.gz`);
  if (platform === 'win32' && arch === 'x64') return zip(`gitleaks_${v}_windows_x64.zip`);
  if (platform === 'win32' && arch === 'ia32') return zip(`gitleaks_${v}_windows_x32.zip`);

  return {
    supported: false,
    reason: `unsupported platform: gitleaks ${GITLEAKS_VERSION} publishes no asset for ${platform}/${arch}`,
    platform,
    arch,
  };
}

/**
 * installPathFor(resolved) — where the extracted binary lands.
 * The Windows member carries a `.exe` suffix, so the install path must too.
 *
 * @param {{member: string}} resolved - the resolveAssetName result.
 * @returns {string} absolute path of the installed binary.
 */
function installPathFor(resolved) {
  return path.join(path.dirname(INSTALL_PATH), resolved.member);
}

/**
 * extractMember(archivePath, destDir, resolved) — extract one member.
 *
 * Phase 88 plan 88-15. The pre-88-15 line was
 * a shell string that ran the gzip-filtered tar extractor — a SHELL STRING
 * with the gzip filter hard-wired. The Windows asset is a `.zip`, which
 * `tar -xzf` cannot read at all, so the real work is branching on the archive
 * FORMAT rather than translating `tar`.
 *
 * Choice of mechanism, and why: no dependency in this tree can unzip, and the
 * `tar.exe` that ships with Windows 10+ IS bsdtar (libarchive), which reads
 * zip when the gzip filter is dropped (`-xf`, auto-detect). That keeps ONE
 * extraction mechanism on every platform and avoids adding a dependency. If
 * that tar cannot read the archive, PowerShell's Expand-Archive is the
 * fallback. Both are execFile-style argv; neither is ever a shell string.
 *
 * @param {string} archivePath - the downloaded archive.
 * @param {string} destDir - directory to extract into.
 * @param {{format: string, member: string}} resolved - the resolveAssetName result.
 * @returns {void}
 * @throws {Error} when the member could not be extracted by any mechanism.
 */
function extractMember(archivePath, destDir, resolved) {
  const args = resolved.format === 'zip'
    ? ['-xf', archivePath, '-C', destDir, resolved.member]
    : ['-xzf', archivePath, '-C', destDir, resolved.member];
  try {
    execFileSync('tar', args, { stdio: 'pipe' });
    return;
  } catch (tarErr) {
    if (resolved.format !== 'zip') throw tarErr;
    const powershell = process.env.GSD_POWERSHELL_EXE || 'powershell.exe';
    execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:GSD_ARCHIVE -DestinationPath $env:GSD_DEST -Force',
    ], { stdio: 'pipe', env: { ...process.env, GSD_ARCHIVE: archivePath, GSD_DEST: destDir } });
  }
}


/**
 * Download a URL to a local file path, following redirects.
 * Returns a Promise that resolves when the file is fully written.
 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const request = https.get(url, (response) => {
      // Follow redirects (GitHub releases uses 302 → S3)
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        try { unlinkSync(destPath); } catch (_) { /* ignore */ }
        download(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    request.on('error', (err) => {
      file.close();
      try { unlinkSync(destPath); } catch (_) { /* ignore */ }
      reject(err);
    });
  });
}

async function main() {
  // Skip if already installed. The installed name carries `.exe` on Windows,
  // so the probe asks resolveAssetName where the binary would be.
  const probe = resolveAssetName();
  const existingPath = probe.supported ? installPathFor(probe) : INSTALL_PATH;
  if (existsSync(existingPath)) {
    console.log('[gsd-security] gitleaks already installed at', existingPath);
    process.exit(0);
  }

  const resolved = resolveAssetName();
  if (!resolved.supported) {
    // An EXPLICIT unsupported result, never a silent absence: the scanner is
    // reported as unavailable, which is not the same as a clean scan.
    console.warn(`[gsd-security] UNSUPPORTED: ${resolved.reason}. Skipping gitleaks install.`);
    console.warn('[gsd-security] Secret scanning will be reported as UNAVAILABLE, not as clean.');
    process.exit(0); // never block npm install
  }
  const assetName = resolved.asset;

  const downloadUrl = `https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/${assetName}`;
  const tarPath = path.join(TMP_DIR, assetName);

  console.log(`[gsd-security] Installing gitleaks ${GITLEAKS_VERSION} for ${process.platform}/${process.arch}...`);
  console.log(`[gsd-security] Download URL: ${downloadUrl}`);

  try {
    // Download the tarball
    await download(downloadUrl, tarPath);
    console.log('[gsd-security] Download complete. Extracting...');

    // Ensure node_modules/.bin exists
    const binDir = path.dirname(INSTALL_PATH);
    if (!existsSync(binDir)) {
      mkdirSync(binDir, { recursive: true });
    }

    // Extract the binary into node_modules/.bin/. BRANCH ON THE ARCHIVE
    // FORMAT, not on the platform: the Windows asset is a .zip, which
    // `tar -xzf` (gzip filter) cannot read.
    extractMember(tarPath, binDir, resolved);

    // Make executable (a no-op mode change on Windows, harmless)
    chmodSync(installPathFor(resolved), 0o755);

    // Clean up tarball
    try { unlinkSync(tarPath); } catch (_) { /* ignore cleanup failure */ }

    console.log('[gsd-security] gitleaks installed successfully at', installPathFor(resolved));
  } catch (err) {
    console.warn(`[gsd-security] gitleaks install failed: ${err.message}`);
    console.warn('[gsd-security] Secret scanning will be skipped. Install gitleaks manually for full coverage.');
    // Clean up partial download
    try { unlinkSync(tarPath); } catch (_) { /* ignore */ }
    process.exit(0); // never block npm install
  }
}

// Phase 88 plan 88-15: run as a script, but expose the resolver so a test can
// assert the asset table for every platform/arch WITHOUT downloading anything.
if (require.main === module) {
  main();
} else {
  module.exports = { resolveAssetName, installPathFor, extractMember };
}
