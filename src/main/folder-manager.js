'use strict';

const fileService = require('../services/file-service');
const imageService = require('../services/image-service');

/**
 * Folder scanning + thumbnail generation for the renderer. Thumbnails are
 * 120x120 JPEGs cached under data/thumbs (Section 17) and never full images.
 */
class FolderManager {
  async listImages(folder, { includeSubfolders = false } = {}) {
    return fileService.listImagesInFolder(folder, { includeSubfolders: !!includeSubfolders });
  }

  async generateThumbnailBase64(imagePath) {
    return imageService.generateThumbnailDataUrl(imagePath);
  }

  async scanWithThumbnails(folder, { includeSubfolders = false, maxThumbs = 120 } = {}) {
    const images = await this.listImages(folder, { includeSubfolders });
    const limited = images.slice(0, Math.max(0, Math.min(Number(maxThumbs) || 120, 500)));
    const withThumbs = await imageService.mapLimit(limited, 4, async (image) => ({
      ...image,
      thumb: await imageService.generateThumbnailSafe(image.path)
    }));
    const rest = images.slice(limited.length).map((image) => ({ ...image, thumb: null }));
    return { images: [...withThumbs, ...rest], total: images.length, withThumbs: limited.length };
  }
}

module.exports = { FolderManager, folderManager: new FolderManager() };
