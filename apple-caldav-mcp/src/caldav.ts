import {
  createDAVClient,
  type DAVCalendar,
  type DAVCalendarObject
} from "tsdav";
import type { AppConfig } from "./config.js";
import { buildEventIcs, parseEventIcs } from "./ical.js";
import type { CalendarSummary, EventSummary } from "./types.js";

export type CaldavAdapter = {
  listCalendars(): Promise<CalendarSummary[]>;
  listEvents(calendarName: string, from?: string, to?: string): Promise<EventSummary[]>;
  getEvent(calendarName: string, eventId: string): Promise<EventSummary>;
  createEvent(input: EventSummary): Promise<EventSummary>;
  updateEvent(input: EventSummary): Promise<EventSummary>;
  deleteEvent(calendarName: string, eventId: string, etag?: string): Promise<void>;
};

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

type ResolvedCalendar = {
  calendar: DAVCalendar;
  summary: CalendarSummary;
};

type ResolvedEventObject = {
  calendar: ResolvedCalendar;
  object: DAVCalendarObject;
  uid: string;
  event: EventSummary;
};

export function createCaldavAdapter(config: AppConfig): CaldavAdapter {
  let clientPromise: Promise<DavClient> | undefined;

  return {
    async listCalendars() {
      const client = await getClient();
      const calendars = await client.fetchCalendars();
      return calendars.map(toCalendarSummary);
    },

    async listEvents(calendarName, from, to) {
      const client = await getClient();
      const resolvedCalendar = await resolveCalendar(calendarName);
      const objects = await client.fetchCalendarObjects({
        calendar: resolvedCalendar.calendar,
        ...buildTimeRangeParams(from, to)
      });

      return objects
        .map((object) => toEventSummary(resolvedCalendar.summary.id, object))
        .filter((event) => eventOverlapsRange(event, from, to))
        .sort(compareEvents);
    },

    async getEvent(calendarName, eventId) {
      const resolved = await resolveEventObject(calendarName, eventId);
      return resolved.event;
    },

    async createEvent(input) {
      const client = await getClient();
      const resolvedCalendar = await resolveCalendar(input.calendar);
      const iCalString = buildEventIcs(stripEtag(input));
      const filename = buildEventFilename(input.id);

      const response = await client.createCalendarObject({
        calendar: resolvedCalendar.calendar,
        filename,
        iCalString
      });
      await ensureSuccessfulResponse(response, `create event ${input.id}`);

      return refetchEventByUrl(resolvedCalendar, buildCalendarObjectUrl(resolvedCalendar.calendar, filename));
    },

    async updateEvent(input) {
      const client = await getClient();
      const resolved = await resolveEventObject(input.calendar, input.id);
      const data = buildEventIcs({
        ...stripEtag(input),
        id: resolved.uid
      });
      const etag = input.etag ?? resolved.object.etag;

      const response = await client.updateCalendarObject({
        calendarObject: {
          ...resolved.object,
          data,
          ...(etag === undefined ? {} : { etag })
        }
      });
      await ensureSuccessfulResponse(response, `update event ${input.id}`);

      return refetchEventByUrl(resolved.calendar, resolved.object.url);
    },

    async deleteEvent(calendarName, eventId, etag) {
      const client = await getClient();
      const resolved = await resolveEventObject(calendarName, eventId);

      const response = await client.deleteCalendarObject({
        calendarObject: {
          ...resolved.object,
          ...(etag ?? resolved.object.etag
            ? {
                etag: etag ?? resolved.object.etag
              }
            : {})
        }
      });
      await ensureSuccessfulResponse(response, `delete event ${eventId}`);
    }
  };

  function getClient(): Promise<DavClient> {
    clientPromise ??= createDAVClient({
      serverUrl: config.caldavUrl,
      credentials: {
        username: config.caldavUsername,
        password: config.caldavPassword
      },
      authMethod: "Basic",
      defaultAccountType: "caldav"
    });
    return clientPromise;
  }

  async function resolveCalendar(calendarName: string): Promise<ResolvedCalendar> {
    const client = await getClient();
    const calendars = await client.fetchCalendars();
    const resolvedCalendars = calendars.map((calendar) => ({
      calendar,
      summary: toCalendarSummary(calendar)
    }));

    const match = resolvedCalendars.find(
      ({ summary }) => summary.name === calendarName || summary.id === calendarName
    );
    if (!match) {
      throw new Error(`Calendar not found: ${calendarName}`);
    }

    return match;
  }

  async function resolveEventObject(
    calendarName: string,
    eventId: string
  ): Promise<ResolvedEventObject> {
    const client = await getClient();
    const resolvedCalendar = await resolveCalendar(calendarName);
    const objectUrls = buildCandidateObjectUrls(resolvedCalendar.calendar, eventId);
    const objects = await client.fetchCalendarObjects({
      calendar: resolvedCalendar.calendar,
      objectUrls
    });
    const object = objects.find((candidate) => urlsMatch(candidate.url, objectUrls));
    if (!object) {
      throw new Error(`Event not found in calendar ${calendarName}: ${eventId}`);
    }

    const parsedEvent = parseCalendarObject(resolvedCalendar.summary.id, object);
    return {
      calendar: resolvedCalendar,
      object,
      uid: parsedEvent.id,
      event: normalizeParsedEvent(parsedEvent, object)
    };
  }

  async function refetchEventByUrl(
    resolvedCalendar: ResolvedCalendar,
    objectUrl: string
  ): Promise<EventSummary> {
    const client = await getClient();
    const [object] = await client.fetchCalendarObjects({
      calendar: resolvedCalendar.calendar,
      objectUrls: [objectUrl]
    });
    if (!object) {
      throw new Error(`Event resource not found after write: ${objectUrl}`);
    }

    return toEventSummary(resolvedCalendar.summary.id, object);
  }
}

function toCalendarSummary(calendar: DAVCalendar): CalendarSummary {
  return {
    id: calendar.url,
    name: getCalendarName(calendar),
    url: calendar.url
  };
}

function getCalendarName(calendar: DAVCalendar): string {
  if (typeof calendar.displayName === "string" && calendar.displayName.trim().length > 0) {
    return calendar.displayName.trim();
  }

  return decodeCalendarPathSegment(calendar.url);
}

function decodeCalendarPathSegment(url: string): string {
  try {
    const path = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? url);
  } catch {
    return url;
  }
}

function toEventSummary(calendarName: string, object: DAVCalendarObject): EventSummary {
  return normalizeParsedEvent(parseCalendarObject(calendarName, object), object);
}

function stripEtag(input: EventSummary): Omit<EventSummary, "etag"> {
  const { etag: _etag, ...event } = input;
  return event;
}

function parseCalendarObject(calendarId: string, object: DAVCalendarObject): EventSummary {
  if (typeof object.data !== "string") {
    throw new Error(`Calendar object ${object.url} did not include ICS data`);
  }

  return parseEventIcs(calendarId, object.etag, object.data);
}

function normalizeParsedEvent(event: EventSummary, object: DAVCalendarObject): EventSummary {
  return {
    ...event,
    id: object.url
  };
}

function buildEventFilename(eventId: string): string {
  return `${encodeURIComponent(eventId)}.ics`;
}

function buildCalendarObjectUrl(calendar: DAVCalendar, filename: string): string {
  return new URL(filename, ensureTrailingSlash(calendar.url)).toString();
}

function buildCandidateObjectUrls(calendar: DAVCalendar, eventId: string): string[] {
  const candidates = new Set<string>();
  const canonicalUrl = tryNormalizeUrl(eventId);
  if (canonicalUrl) {
    candidates.add(canonicalUrl);
  }

  candidates.add(buildCalendarObjectUrl(calendar, buildEventFilename(eventId)));
  return [...candidates];
}

function tryNormalizeUrl(value: string): string | undefined {
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function urlsMatch(url: string, candidates: string[]): boolean {
  return candidates.includes(url);
}

function buildTimeRangeParams(
  from?: string,
  to?: string
): {
  timeRange?: {
    start: string;
    end: string;
  };
} {
  if (!from && !to) {
    return {};
  }

  return {
    timeRange: {
      start: from ?? OPEN_RANGE_START,
      end: to ?? OPEN_RANGE_END
    }
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function ensureSuccessfulResponse(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = (await response.text()).trim();
  throw new Error(
    `${action} failed with ${response.status} ${response.statusText}${
      body ? `: ${body}` : ""
    }`
  );
}

function eventOverlapsRange(event: EventSummary, from?: string, to?: string): boolean {
  if (!from && !to) {
    return true;
  }

  const startMs = parseInstant(event.start);
  const endMs = parseInstant(event.end);
  const fromMs = from ? parseInstant(from) : undefined;
  const toMs = to ? parseInstant(to) : undefined;

  if (fromMs !== undefined && endMs < fromMs) {
    return false;
  }

  if (toMs !== undefined && startMs > toMs) {
    return false;
  }

  return true;
}

function parseInstant(value: string): number {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }

  return instant;
}

function compareEvents(left: EventSummary, right: EventSummary): number {
  const startDifference = Date.parse(left.start) - Date.parse(right.start);
  if (startDifference !== 0) {
    return startDifference;
  }

  return left.id.localeCompare(right.id);
}

const OPEN_RANGE_START = "1900-01-01T00:00:00.000Z";
const OPEN_RANGE_END = "2100-01-01T00:00:00.000Z";
