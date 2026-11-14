'use strict';

/**
 * Upload facade. The actual file-chooser interception lives in
 * gemini-adapter.js (CDP: Page.setInterceptFileChooserDialog +
 * DOM.setFileInputFiles), which is the supported approach for the real Gemini
 * page. This module exists so upload logic can be exercised independently.
 */

async function uploadImage(adapter, filePath, timeoutMs = 45000) {
  if (!adapter) throw new Error('A GeminiAdapter instance is required');
  const baseline = await adapter.attachmentCount();
  await adapter.uploadFile(filePath, timeoutMs);
  await adapter.verifyUploadComplete(baseline, timeoutMs);
  return true;
}

module.exports = { uploadImage };
