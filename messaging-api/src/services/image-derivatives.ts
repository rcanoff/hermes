import path from 'node:path'
import sharp from 'sharp'

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif'])

export function isAcceptedImageMime(mime: string): boolean {
  return ACCEPTED_MIME.has(mime.toLowerCase())
}

export function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/png':
      return '.png'
    case 'image/heic':
      return '.heic'
    case 'image/heif':
      return '.heif'
    default:
      return '.jpg'
  }
}

export async function generateAttachmentDerivatives(input: {
  inputPath: string
  outputDir: string
  thumbMaxEdgePx: number
  visionMaxEdgePx: number
}): Promise<{ thumbPath: string; visionPath: string; width: number; height: number }> {
  const meta = await sharp(input.inputPath, { failOn: 'none' }).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  const thumbPath = path.join(input.outputDir, 'thumb.jpg')
  const visionPath = path.join(input.outputDir, 'vision.jpg')

  await sharp(input.inputPath)
    .resize(input.thumbMaxEdgePx, input.thumbMaxEdgePx, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toFile(thumbPath)

  await sharp(input.inputPath)
    .resize(input.visionMaxEdgePx, input.visionMaxEdgePx, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toFile(visionPath)

  return { thumbPath, visionPath, width, height }
}