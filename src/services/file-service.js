'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_SCAN_DEPTH = 8;

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function isDirectory(target) {
  try {
    const stat = await fsp.stat(target);
    return stat.isDirectory();
  } catch (err) {
    return false;
  }
}

async function verifyReadable(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size === 0) return false;
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch (err) {
    return false;
  }
}

async function verifyImage(filePath) {
  try {
    if (!(await verifyReadable(filePath))) return false;
    const meta = await sharp(filePath).metadata();
    return !!(meta.width && meta.height && meta.format);
  } catch (err) {
    return false;
  }
}

async function walk(folder, includeSubfolders, depth, output) {
  let entries;
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (includeSubfolders && depth < MAX_SCAN_DEPTH) {
        await walk(fullPath, includeSubfolders, depth + 1, output);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.size <= 0) continue;
      output.push({
        path: fullPath,
        name: entry.name,
        size: stat.size,
        ext: ext.replace('.', '')
      });
    } catch (err) {
      // Unreadable file: skip, never abort a whole scan for one file.
    }
  }
}

async function listImagesInFolder(folder, { includeSubfolders = false } = {}) {
  const images = [];
  await walk(folder, !!includeSubfolders, 0, images);
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return images;
}

module.exports = {
  IMAGE_EXTENSIONS,
  ensureDir,
  isDirectory,
  verifyReadable,
  verifyImage,
  listImagesInFolder
};
