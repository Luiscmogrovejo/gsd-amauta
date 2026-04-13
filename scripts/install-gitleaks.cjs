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
const { execSync } = require('child_process');
const https = require('https');
const path = require('path');
const os = require('os');

const GITLEAKS_VERSION = 'v8.18.4';

const INSTALL_PATH = path.resolve(__dirname, '..', 'node_modules', '.bin', 'gitleaks');
const TMP_DIR = os.tmpdir();

/**
 * Resolve the GitHub releases asset filename for the current OS/arch.
 * Returns null if the platform is unsupported.
 */
function resolveAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux' && arch === 'x64') return `gitleaks_${GITLEAKS_VERSION.replace('v', '')}_linux_x64.tar.gz`;
  if (platform === 'linux' && arch === 'arm64') return `gitleaks_${GITLEAKS_VERSION.replace('v', '')}_linux_arm64.tar.gz`;
  if (platform === 'darwin' && arch === 'x64') return `gitleaks_${GITLEAKS_VERSION.replace('v', '')}_darwin_x64.tar.gz`;
  if (platform === 'darwin' && arch === 'arm64') return `gitleaks_${GITLEAKS_VERSION.replace('v', '')}_darwin_arm64.tar.gz`;

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
    console.log('[gsd-security] gitleaks already installed at', INSTALL_PATH);
    process.exit(0);
  }

  const assetName = resolveAssetName();
  if (!assetName) {
    console.warn(`[gsd-security] Unsupported platform: ${process.platform}/${process.arch}. Skipping gitleaks install.`);
    console.warn('[gsd-security] Secret scanning will be skipped. Install gitleaks manually for full coverage.');
    process.exit(0); // never block npm install
  }

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

    // Extract the gitleaks binary from the tarball into node_modules/.bin/
    execSync(`tar -xzf "${tarPath}" -C "${binDir}" gitleaks`, { stdio: 'pipe' });

    // Make executable
    chmodSync(INSTALL_PATH, 0o755);

    // Clean up tarball
    try { unlinkSync(tarPath); } catch (_) { /* ignore cleanup failure */ }

    console.log('[gsd-security] gitleaks installed successfully at', INSTALL_PATH);
  } catch (err) {
    console.warn(`[gsd-security] gitleaks install failed: ${err.message}`);
    console.warn('[gsd-security] Secret scanning will be skipped. Install gitleaks manually for full coverage.');
    // Clean up partial download
    try { unlinkSync(tarPath); } catch (_) { /* ignore */ }
    process.exit(0); // never block npm install
  }
}

main();
