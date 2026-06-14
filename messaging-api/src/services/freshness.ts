export function formatFreshness(timestampIso: string, now: Date = new Date()): string {
  const timestampMs = new Date(timestampIso).getTime()
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - timestampMs) / 1000))

  if (elapsedSeconds < 60) {
    return 'just now'
  }

  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) {
    return `${minutes} min ago`
  }

  const hours = Math.floor(elapsedSeconds / 3600)
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  }

  const days = Math.floor(elapsedSeconds / 86400)
  return days === 1 ? '1 day ago' : `${days} days ago`
}