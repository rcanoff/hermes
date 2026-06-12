export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LocationContext {
  lat: number
  lon: number
  accuracy_m: number
  timestamp: string
}

export interface HermesPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function buildHermesMessages(
  history: TranscriptMessage[],
  location?: LocationContext,
): HermesPromptMessage[] {
  const transcript = history.map((message) => ({
    role: message.role,
    content: message.content,
  }))

  if (!location) {
    return transcript
  }

  return [
    {
      role: 'system',
      content: `User's current location: lat ${location.lat}, lon ${location.lon}, accuracy ${location.accuracy_m}m (as of ${location.timestamp})`,
    },
    ...transcript,
  ]
}
