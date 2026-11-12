#!/usr/bin/env node
'use strict';
/**
 * scripts/install-trivy.cjs
 *
 * Downloads the Trivy binary from GitHub releases and places it at
 * node_modules/.bin/trivy for use in npm scripts.
 *
 * Pinned to a specific version to avoid supply chain drift.
 * Exits 0 in ALL cases — never blocks npm install.
 *
 * Usage:
 *   node scripts/install-trivy.cjs
 *   (also hooked via postinstall in package.json if desired)
 */

const { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, readFileSync } = require('fs');
const { execSync, execFileSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');

// Plan 88-16-07. The previous pin, v0.50.1, NO LONGER EXISTS: the tag and every
// asset under it return 404, including `trivy_0.50.1_Linux-64bit.tar.gz`, which
// this installer had always used. Trivy could therefore not be installed on any
// platform. Measured 2026-11-12 with
// `gh api /repos/aquasecurity/trivy/releases/tags/v0.50.1` -> 404.
//
// v0.76.1 was published 2026-10-21 — three weeks old, so it clears the
// "nothing published within the last 7 days" rule, unlike v0.76.2 (2026-11-05).
// The asset naming convention is unchanged.
const TRIVY_VERSION = 'v0.76.1';
const TRIVY_VERSION_PLAIN = '0.76.1'; // used in filename (no 'v' prefix)

/**
 * SHA-256 of every pinned asset, from the release's own
 * `trivy_0.76.1_checksums.txt`. A download is verified against this table and
 * DELETED on a mismatch: an installer that extracts an unverified archive is a
 * supply-chain hole, and neither scanner installer had one before this plan.
 * @type {Record<string, string>}
 */
const TRIVY_SHA256 = {
  'trivy_0.76.1_Linux-64bit.tar.gz': 'c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0',
  'trivy_0.76.1_Linux-ARM64.tar.gz': 'e174dff2a6dba5e3ae41f8d0537a6324405bd08132497340304c6b20e0f16a1f',
  'trivy_0.76.1_macOS-64bit.tar.gz': '7aa762eacd582052d053b62dcf972a1ab058abe39a57ccae234ed8894945b6b7',
  'trivy_0.76.1_macOS-ARM64.tar.gz': '11a9b6cd2752011b54f01ea4bd0dbfa9f0c41dc6538d5a3f9d23955f471bf4e5',
  'trivy_0.76.1_windows-64bit.zip': '1051f49cb22d5284f43425f72aad9cda63ca12ceb92e7caa06903490c82dc9bf',
};

const INSTALL_PATH = path.resolve(__dirname, '..', 'node_modules', '.bin', 'trivy');
const TMP_DIR = os.tmpdir();

/**
 * Resolve the GitHub releases asset filename for the current OS/arch.
 * Returns null if the platform is unsupported.
 *
 * Trivy release naming convention:
 *   Linux x64:  trivy_0.50.1_Linux-64bit.tar.gz
 *   Linux arm64: trivy_0.50.1_Linux-ARM64.tar.gz
 *   macOS x64:  trivy_0.50.1_macOS-64bit.tar.gz
 *   macOS arm64: trivy_0.50.1_macOS-ARM64.tar.gz
 */
/**
 * Resolve the GitHub releases asset for an OS/arch.
 *
 * Phase 88 plan 88-15: the research said "I did not check the trivy
 * installer's table"; measured, it had NO win32 branch either and returned
 * `null`, a silent absence that reads as a clean scan. It now returns a TYPED
 * result naming the platform and architecture.
 *
 * Naming verified against a real release asset list
 * (`gh api /repos/aquasecurity/trivy/releases/tags/v0.69.2`): the Windows
 * asset is `trivy_<ver>_windows-64bit.zip` — lower-case `windows`, a ZIP, and
 * there is NO Windows ARM64 build.
 *
 * NOTE recorded for the operator: the PINNED tag v0.50.1 no longer exists on
 * the releases API (every asset URL, including the Linux one this installer
 * has always used, returns 404), so trivy cannot be installed on ANY platform
 * at this pin. That is a pre-existing defect, not one this plan introduces;
 * bumping the pin is a dependency decision and is routed, not taken here.
 *
 * @param {string} [platform=process.platform]
 * @param {string} [arch=process.arch]
 * @returns {{supported: true, asset: string, format: 'tar.gz'|'zip', member: string}
 *          |{supported: false, reason: string, platform: string, arch: string}}
 */
function resolveAssetName(platform = process.platform, arch = process.arch) {
  const tar = (name) => ({ supported: true, asset: name, format: 'tar.gz', member: 'trivy' });
  const zip = (name) => ({ supported: true, asset: name, format: 'zip', member: 'trivy.exe' });

  if (platform === 'linux' && arch === 'x64') return tar(`trivy_${TRIVY_VERSION_PLAIN}_Linux-64bit.tar.gz`);
  if (platform === 'linux' && arch === 'arm64') return tar(`trivy_${TRIVY_VERSION_PLAIN}_Linux-ARM64.tar.gz`);
  if (platform === 'darwin' && arch === 'x64') return tar(`trivy_${TRIVY_VERSION_PLAIN}_macOS-64bit.tar.gz`);
  if (platform === 'darwin' && arch === 'arm64') return tar(`trivy_${TRIVY_VERSION_PLAIN}_macOS-ARM64.tar.gz`);
  if (platform === 'win32' && arch === 'x64') return zip(`trivy_${TRIVY_VERSION_PLAIN}_windows-64bit.zip`);

  return {
    supported: false,
    reason: `unsupported platform: trivy ${TRIVY_VERSION} publishes no asset for ${platform}/${arch}`,
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
  const expected = TRIVY_SHA256[assetName];
  const actual = sha256OfFile(filePath);
  if (!expected) {
    try { unlinkSync(filePath); } catch (_) { /* best effort */ }
    throw new Error(
      `no pinned SHA-256 for trivy asset ${assetName}; refusing to install an unverified binary`
    );
  }
  if (actual !== expected) {
    try { unlinkSync(filePath); } catch (_) { /* best effort */ }
    throw new Error(
      `trivy asset ${assetName} FAILED checksum verification: expected ${expected}, got ${actual}`
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
    console.log('[gsd-security] trivy already installed at', existingPath);
    process.exit(0);
  }

  const resolved = resolveAssetName();
  if (!resolved.supported) {
    // An EXPLICIT unsupported result, never a silent absence.
    console.warn(`[gsd-security] UNSUPPORTED: ${resolved.reason}. Skipping trivy install.`);
    console.warn('[gsd-security] Container scanning will be reported as UNAVAILABLE, not as clean.');
    process.exit(0); // never block npm install
  }
  const assetName = resolved.asset;

  const downloadUrl = `https://github.com/aquasecurity/trivy/releases/download/${TRIVY_VERSION}/${assetName}`;
  const tarPath = path.join(TMP_DIR, assetName);

  console.log(`[gsd-security] Installing trivy ${TRIVY_VERSION} for ${process.platform}/${process.arch}...`);
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

    // Extract the trivy binary from the tarball into node_modules/.bin/
    // BRANCH ON THE ARCHIVE FORMAT, not on the platform: the Windows asset is
    // a .zip, which `tar -xzf` (gzip filter) cannot read.
    extractMember(tarPath, binDir, resolved);

    // Make executable
    chmodSync(installPathFor(resolved), 0o755);

    // Clean up tarball
    try { unlinkSync(tarPath); } catch (_) { /* ignore cleanup failure */ }

    console.log('[gsd-security] trivy installed successfully at', installPathFor(resolved));
  } catch (err) {
    console.warn(`[gsd-security] trivy install failed: ${err.message}`);
    console.warn('[gsd-security] Container scanning will be skipped. Install trivy manually for full coverage.');
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
    TRIVY_SHA256,
    sha256OfFile,
    verifyChecksum,
    resolveAssetName,
    installPathFor,
    extractMember,
  };
}
