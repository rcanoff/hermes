import path from 'node:path'
import sharp from 'sharp'

const ACCEPTED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif'])
const ACCEPTED_DOCUMENT_MIME = new Set([
  'text/plain',
  'application/pdf',
  'application/octet-stream',
])

export function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(';')[0].trim()
}

export function isAcceptedImageMime(mime: string): boolean {
  return ACCEPTED_IMAGE_MIME.has(normalizeMime(mime))
}

export function isAcceptedDocumentMime(mime: string): boolean {
  return ACCEPTED_DOCUMENT_MIME.has(normalizeMime(mime))
}

export function isAcceptedAttachmentMime(mime: string): boolean {
  return isAcceptedImageMime(mime) || isAcceptedDocumentMime(mime)
}

export function extensionForMime(mime: string): string {
  switch (normalizeMime(mime)) {
    case 'image/png':
      return '.png'
    case 'image/heic':
      return '.heic'
    case 'image/heif':
      return '.heif'
    case 'text/plain':
      return '.txt'
    case 'application/pdf':
      return '.pdf'
    case 'application/octet-stream':
      return '.bin'
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