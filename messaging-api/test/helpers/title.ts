import type { FakeHermesClient } from './hermes.js'

export function prepareTitleResponse(hermesClient: FakeHermesClient, title = 'Title'): void {
  hermesClient.queueCompleteChatResponse(title)
}

export async function waitForTitleGeneration(hermesClient: FakeHermesClient): Promise<void> {
  await waitFor(() => hermesClient.completeRequests.length >= 1)
}

export async function completeTitleAfterReply(hermesClient: FakeHermesClient, title = 'Title'): Promise<void> {
  prepareTitleResponse(hermesClient, title)
  await waitForTitleGeneration(hermesClient)
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}