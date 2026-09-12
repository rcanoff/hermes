export type ReplyAssembler = {
  pushToken: (text: string) => void
  onToolActivity: () => void
  tokens: () => readonly string[]
  text: () => string
  reset: () => void
}

export function createReplyAssembler(): ReplyAssembler {
  let parts: string[] = []

  return {
    pushToken(text: string) {
      if (text) {
        parts.push(text)
      }
    },
    onToolActivity() {
      parts = []
    },
    tokens: () => parts,
    text: () => parts.join(''),
    reset() {
      parts = []
    },
  }
}
