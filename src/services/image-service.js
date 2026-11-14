'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const paths = require('../main/paths');

const THUMB_SIZE = 120;

function ensureThumbsDir() {
  const dir = paths.thumbsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getMetadata(imagePath) {
  const meta = await sharp(imagePath).metadata();
  return {
    width: meta.width || 0,
    height: meta.height || 0,
    format: meta.format || 'unknown',
    size: meta.size || 0
  };
}

function thumbPathFor(imagePath) {
  const hash = crypto.createHash('sha1').update(String(imagePath)).digest('hex');
  return path.join(paths.thumbsDir, `${hash}.jpg`);
}

async function generateThumbnail(imagePath) {
  ensureThumbsDir();
  const target = thumbPathFor(imagePath);
  try {
    await fsp.access(target, fs.constants.R_OK);
    return target;
  } catch (err) {
    // not cached yet
  }
  await sharp(imagePath, { limitInputPixels: 178956970 })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
    .jpeg({ quality: 72, mozjpeg: true })
    .toFile(target);
  return target;
}

async function generateThumbnailDataUrl(imagePath) {
  const thumbPath = await generateThumbnail(imagePath);
  const buffer = await fsp.readFile(thumbPath);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function generateThumbnailSafe(imagePath) {
  try {
    return await generateThumbnailDataUrl(imagePath);
  } catch (err) {
    return null;
  }
}

/**
 * Convert any browser-downloaded bytes into a real PNG (verifies readability
 * with sharp as a side effect). Returns metadata for the written file.
 */
async function convertToPng(inputPath, outputPath) {
  await sharp(inputPath, { limitInputPixels: 178956970 })
    .png()
    .toFile(outputPath);
  return getMetadata(outputPath);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current], current);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = {
  getMetadata,
  generateThumbnail,
  generateThumbnailDataUrl,
  generateThumbnailSafe,
  convertToPng,
  mapLimit
};
