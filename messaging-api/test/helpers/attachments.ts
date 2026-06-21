import sharp from 'sharp'

export async function createTinyJpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg()
    .toBuffer()
}

export function buildMultipartImagePayload(
  buffer: Buffer,
  boundary: string,
  filename: string,
  mime: string,
): Buffer {
  const preamble = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${mime}`,
      '',
      '',
    ].join('\r\n'),
    'utf8',
  )
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return Buffer.concat([preamble, buffer, closing])
}