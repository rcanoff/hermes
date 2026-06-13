import type Database from 'better-sqlite3'
import {
  getLocationEventById,
  updateLocationEventAddress,
} from '../db/repos/location-events.js'
import type { HermesClient } from './hermes-client.js'

export class AddressEnrichmentQueue {
  constructor(
    private readonly db: Database.Database,
    private readonly hermesClient: HermesClient,
    private readonly sessionId: string,
  ) {}

  enqueue(eventId: string): void {
    setImmediate(() => void this.process(eventId))
  }

  private async process(eventId: string): Promise<void> {
    const event = getLocationEventById(this.db, eventId)
    if (!event || event.address_status !== 'pending') {
      return
    }

    try {
      const address = await this.reverseGeocode(event.lat, event.lon)
      updateLocationEventAddress(this.db, eventId, address, 'server', 'resolved')
    } catch {
      updateLocationEventAddress(this.db, eventId, '', 'server', 'failed')
    }
  }

  private async reverseGeocode(lat: number, lon: number): Promise<string> {
    const address = await this.hermesClient.completeChat({
      hermesSessionId: this.sessionId,
      messages: [
        {
          role: 'user',
          content: `Return only a single-line postal address for lat ${lat} lon ${lon}. No other text.`,
        },
      ],
    })

    if (!address) {
      throw new Error('Hermes returned an empty address')
    }

    return address
  }
}