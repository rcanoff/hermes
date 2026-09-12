import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  extensionForMime,
  generateAttachmentDerivatives,
  isAcceptedAttachmentMime,
  isAcceptedDocumentMime,
  isAcceptedImageMime,
} from '../src/services/image-derivatives.js'

describe('generateAttachmentDerivatives', () => {
  let dir: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'))
    const src = path.join(dir, 'input.png')
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toFile(src)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('accepts image and document MIME types and rejects others', () => {
    expect(isAcceptedImageMime('image/jpeg')).toBe(true)
    expect(isAcceptedImageMime('image/png')).toBe(true)
    expect(isAcceptedDocumentMime('text/plain')).toBe(true)
    expect(isAcceptedDocumentMime('text/plain; charset=utf-8')).toBe(true)
    expect(isAcceptedAttachmentMime('application/pdf')).toBe(true)
    expect(isAcceptedAttachmentMime('application/octet-stream')).toBe(true)
    expect(isAcceptedAttachmentMime('application/zip')).toBe(false)
    expect(isAcceptedAttachmentMime('image/gif')).toBe(false)
    expect(isAcceptedAttachmentMime('video/mp4')).toBe(false)
    expect(extensionForMime('text/plain')).toBe('.txt')
    expect(extensionForMime('application/pdf')).toBe('.pdf')
    expect(extensionForMime('application/octet-stream')).toBe('.bin')
  })

  it('writes thumb and vision JPEG files', async () => {
    const result = await generateAttachmentDerivatives({
      inputPath: path.join(dir, 'input.png'),
      outputDir: dir,
      thumbMaxEdgePx: 200,
      visionMaxEdgePx: 400,
    })
    expect(fs.existsSync(result.thumbPath)).toBe(true)
    expect(fs.existsSync(result.visionPath)).toBe(true)
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })
})