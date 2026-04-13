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

const { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync } = require('fs');
const { execSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');

const TRIVY_VERSION = 'v0.50.1';
const TRIVY_VERSION_PLAIN = '0.50.1'; // used in filename (no 'v' prefix)

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
function resolveAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux' && arch === 'x64') return `trivy_${TRIVY_VERSION_PLAIN}_Linux-64bit.tar.gz`;
  if (platform === 'linux' && arch === 'arm64') return `trivy_${TRIVY_VERSION_PLAIN}_Linux-ARM64.tar.gz`;
  if (platform === 'darwin' && arch === 'x64') return `trivy_${TRIVY_VERSION_PLAIN}_macOS-64bit.tar.gz`;
  if (platform === 'darwin' && arch === 'arm64') return `trivy_${TRIVY_VERSION_PLAIN}_macOS-ARM64.tar.gz`;

  return null;
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
  // Skip if already installed
  if (existsSync(INSTALL_PATH)) {
    console.log('[gsd-security] trivy already installed at', INSTALL_PATH);
    process.exit(0);
  }

  const assetName = resolveAssetName();
  if (!assetName) {
    console.warn(`[gsd-security] Unsupported platform: ${process.platform}/${process.arch}. Skipping trivy install.`);
    console.warn('[gsd-security] Container scanning will be skipped. Install trivy manually for full coverage.');
    process.exit(0); // never block npm install
  }

  const downloadUrl = `https://github.com/aquasecurity/trivy/releases/download/${TRIVY_VERSION}/${assetName}`;
  const tarPath = path.join(TMP_DIR, assetName);

  console.log(`[gsd-security] Installing trivy ${TRIVY_VERSION} for ${process.platform}/${process.arch}...`);
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

    // Extract the trivy binary from the tarball into node_modules/.bin/
    execSync(`tar -xzf "${tarPath}" -C "${binDir}" trivy`, { stdio: 'pipe' });

    // Make executable
    chmodSync(INSTALL_PATH, 0o755);

    // Clean up tarball
    try { unlinkSync(tarPath); } catch (_) { /* ignore cleanup failure */ }

    console.log('[gsd-security] trivy installed successfully at', INSTALL_PATH);
  } catch (err) {
    console.warn(`[gsd-security] trivy install failed: ${err.message}`);
    console.warn('[gsd-security] Container scanning will be skipped. Install trivy manually for full coverage.');
    // Clean up partial download
    try { unlinkSync(tarPath); } catch (_) { /* ignore */ }
    process.exit(0); // never block npm install
  }
}

main();
