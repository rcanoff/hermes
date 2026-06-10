import type { CaldavAdapter } from "./caldav.js";
import type { EventSummary } from "./types.js";

export function buildToolHandlers(adapter: CaldavAdapter) {
  return {
    list_calendars: async (_input: Record<string, never>) => adapter.listCalendars(),
    list_events: async (input: { calendar: string; from?: string; to?: string }) =>
      adapter.listEvents(input.calendar, input.from, input.to),
    get_event: async (input: { calendar: string; id: string }) =>
      adapter.getEvent(input.calendar, input.id),
    create_event: async (input: EventSummary) => adapter.createEvent(input),
    update_event: async (input: EventSummary) => adapter.updateEvent(input),
    delete_event: async (input: { calendar: string; id: string; etag?: string }) =>
      adapter.deleteEvent(input.calendar, input.id, input.etag)
  };
}
