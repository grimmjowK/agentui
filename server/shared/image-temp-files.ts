import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type UploadedImagePayload = {
  name?: string;
  data?: string;
  mimeType?: string;
  size?: number;
};

export type ProcessedImagesResult = {
  modifiedCommand: string;
  tempImagePaths: string[];
  tempDir: string | null;
};

/**
 * Saves base64 data-URL images to `<cwd>/.tmp/images/<timestamp>/image_<index>.<ext>`
 * and appends their absolute paths to the prompt so CLI/SDK agents can read them.
 */
export async function handleImages(
  command: string,
  images?: unknown[] | null,
  cwd?: string | null,
): Promise<ProcessedImagesResult> {
  const tempImagePaths: string[] = [];
  let tempDir: string | null = null;
  const safeCommand = typeof command === 'string' ? command : '';

  if (!Array.isArray(images) || images.length === 0) {
    return { modifiedCommand: safeCommand, tempImagePaths, tempDir };
  }

  try {
    const workingDir = cwd || process.cwd();
    const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    tempDir = path.join(workingDir, '.tmp', 'images', uniqueSuffix);
    await fs.mkdir(tempDir, { recursive: true });

    for (const [index, rawImage] of images.entries()) {
      if (!rawImage || typeof rawImage !== 'object') continue;
      const image = rawImage as UploadedImagePayload;
      if (typeof image.data !== 'string') continue;

      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const rawExt = (mimeType.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '');
      const extension = rawExt || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    let modifiedCommand = safeCommand;
    if (tempImagePaths.length > 0) {
      const imageList = tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
      const imageNote = `[Images provided at the following paths:]\n${imageList}`;
      modifiedCommand = safeCommand.trim() ? `${safeCommand}\n\n${imageNote}` : imageNote;
    }

    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for provider:', error);
    return { modifiedCommand: safeCommand, tempImagePaths, tempDir };
  }
}

/**
 * Removes temporary image files and directory created by `handleImages`.
 */
export async function cleanupTempFiles(
  tempImagePaths?: string[] | null,
  tempDir?: string | null,
): Promise<void> {
  if (!Array.isArray(tempImagePaths) || tempImagePaths.length === 0) {
    return;
  }

  try {
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch((err) =>
        console.error(`Failed to delete temp image ${imagePath}:`, err),
      );
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((err) =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err),
      );
    }
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}
