import fs from 'node:fs'
import path from 'node:path'

export function attachmentRoot(attachmentsDir: string, userId: string, attachmentId: string): string {
  return path.join(attachmentsDir, userId, attachmentId)
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function removeAttachmentTree(
  attachmentsDir: string,
  userId: string,
  attachmentId: string,
): void {
  fs.rmSync(attachmentRoot(attachmentsDir, userId, attachmentId), { recursive: true, force: true })
}

export function resolveAttachmentFile(
  attachmentsDir: string,
  userId: string,
  attachmentId: string,
  filename: string,
): string {
  return path.join(attachmentRoot(attachmentsDir, userId, attachmentId), filename)
}