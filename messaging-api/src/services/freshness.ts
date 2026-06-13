export function formatFreshness(timestampIso: string, now: Date = new Date()): string {
  const timestampMs = new Date(timestampIso).getTime()
  const elapsedSeconds = Math.floor((now.getTime() - timestampMs) / 1000)

  if (elapsedSeconds < 60) {
    return 'just now'
  }

  const minutes = Math.floor(elapsedSeconds / 60)
  return `${minutes} min ago`
}