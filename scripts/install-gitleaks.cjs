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

const { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, readFileSync } = require('fs');
const { execSync, execFileSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');

const GITLEAKS_VERSION = 'v8.18.4';

/**
 * SHA-256 of every pinned asset, from the release's own
 * `gitleaks_8.18.4_checksums.txt` (plan 88-16-07). A download is verified
 * against this table and DELETED on a mismatch. The tag still exists — unlike
 * trivy's old pin — so only the verification is new here.
 * @type {Record<string, string>}
 */
const GITLEAKS_SHA256 = {
  'gitleaks_8.18.4_linux_x64.tar.gz': 'ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d',
  'gitleaks_8.18.4_linux_arm64.tar.gz': 'bf5f7f466ebfade1296c8bd32cf7d3f592c2aa78836aa9980ffbe2cadca7a861',
  'gitleaks_8.18.4_darwin_x64.tar.gz': '1a69e5666b13cd374889cbcb1939ed1573b63b551251283d5d2329a53cf58e2f',
  'gitleaks_8.18.4_darwin_arm64.tar.gz': 'a480d8593acd8215b22402cf0f3f88b01dcd3610c63b5391db640f7767e62104',
  'gitleaks_8.18.4_windows_x64.zip': '9ba442ca7dda19885a2e569f43a127289feeb2b5fb0dfa251dafd277f4a0ba91',
  'gitleaks_8.18.4_windows_x32.zip': '338edd2932b583c13f4c3421a97b1611349f2a9a1c818e521abd3a3a6379d395',
};

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


/**
 * SHA-256 of a file on disk, as lower-case hex.
 *
 * @param {string} filePath absolute path of the downloaded asset
 * @returns {string} the digest
 */
function sha256OfFile(filePath) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Verify a downloaded asset against the pinned digest. FAIL CLOSED.
 *
 * Plan 88-16-07: neither scanner installer verified anything before this, so a
 * compromised or truncated release asset was extracted and put on PATH as a
 * security tool. An asset with no pinned digest is also a refusal, not a pass:
 * silence would defeat the point the moment the asset table grows a row.
 *
 * @param {string} filePath the downloaded archive
 * @param {string} assetName the asset's release filename, the table's key
 * @returns {string} the verified digest
 * @throws {Error} on a mismatch or a missing pin; the file is removed first
 */
function verifyChecksum(filePath, assetName) {
  const expected = GITLEAKS_SHA256[assetName];
  const actual = sha256OfFile(filePath);
  if (!expected) {
    try { unlinkSync(filePath); } catch (_) { /* best effort */ }
    throw new Error(
      `no pinned SHA-256 for gitleaks asset ${assetName}; refusing to install an unverified binary`
    );
  }
  if (actual !== expected) {
    try { unlinkSync(filePath); } catch (_) { /* best effort */ }
    throw new Error(
      `gitleaks asset ${assetName} FAILED checksum verification: expected ${expected}, got ${actual}`
    );
  }
  return actual;
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
    verifyChecksum(tarPath, assetName);
    console.log('[gsd-security] Download complete and checksum verified. Extracting...');

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
  module.exports = {
    GITLEAKS_SHA256,
    sha256OfFile,
    verifyChecksum,
    resolveAssetName,
    installPathFor,
    extractMember,
  };
}
