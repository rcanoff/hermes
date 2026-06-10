import type { EventSummary } from "./types.js";

type ParsedContentLine = {
  name: string;
  params: Record<string, string>;
  value: string;
};

type ParsedDateValue = {
  iso: string;
  allDay: boolean;
  timezone?: string;
};

const STATUS_MAP = {
  CONFIRMED: "confirmed",
  TENTATIVE: "tentative",
  CANCELLED: "cancelled"
} as const satisfies Record<string, NonNullable<EventSummary["status"]>>;

export function parseEventIcs(
  calendar: string,
  etag: string | undefined,
  raw: string
): EventSummary {
  const eventLines = getVeventLines(raw);
  const properties = eventLines
    .map(parseContentLine)
    .filter((property): property is ParsedContentLine => property !== null);

  const uid = getRequiredValue(properties, "UID");
  const title = getRequiredValue(properties, "SUMMARY");
  const startProperty = getRequiredProperty(properties, "DTSTART");
  const endProperty = getRequiredProperty(properties, "DTEND");
  const start = parseDateValue(startProperty.value, startProperty.params);
  const end = parseDateValue(endProperty.value, endProperty.params);
  const description = getOptionalValue(properties, "DESCRIPTION");
  const location = getOptionalValue(properties, "LOCATION");
  const status = parseStatus(getOptionalValue(properties, "STATUS"));
  const attendees = properties
    .filter((property) => property.name === "ATTENDEE")
    .map((property) => normalizeAttendee(property.value));
  const timezone = start.timezone ?? end.timezone;

  return {
    id: uid,
    calendar,
    ...(etag === undefined ? {} : { etag }),
    title,
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    start: start.iso,
    end: end.iso,
    allDay: start.allDay || end.allDay,
    ...(timezone === undefined ? {} : { timezone }),
    attendees,
    ...(status === undefined ? {} : { status })
  };
}

export function buildEventIcs(input: Omit<EventSummary, "etag">): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hermes//Apple CalDAV MCP//EN",
    "BEGIN:VEVENT",
    `UID:${escapeText(input.id)}`,
    `SUMMARY:${escapeText(input.title)}`,
    ...optionalTextLines("DESCRIPTION", input.description),
    ...optionalTextLines("LOCATION", input.location),
    ...buildDateTimeLines(input),
    ...input.attendees.map((attendee) => `ATTENDEE:mailto:${escapeText(normalizeAttendee(attendee))}`),
    ...optionalStatusLines(input.status),
    "END:VEVENT",
    "END:VCALENDAR"
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function getVeventLines(raw: string): string[] {
  const lines = unfoldLines(raw);
  const startIndex = lines.findIndex((line) => line.toUpperCase() === "BEGIN:VEVENT");
  if (startIndex === -1) {
    throw new Error("VEVENT not found in calendar data");
  }

  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && line.toUpperCase() === "END:VEVENT"
  );
  if (endIndex === -1) {
    throw new Error("VEVENT end marker not found in calendar data");
  }

  return lines.slice(startIndex + 1, endIndex);
}

function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, "\n").split("\n");
  const unfolded: string[] = [];

  for (const line of normalized) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
      continue;
    }

    if (line.length > 0) {
      unfolded.push(line);
    }
  }

  return unfolded;
}

function parseContentLine(line: string): ParsedContentLine | null {
  const valueIndex = line.indexOf(":");
  if (valueIndex === -1) {
    return null;
  }

  const rawDescriptor = line.slice(0, valueIndex);
  const rawValue = line.slice(valueIndex + 1);
  const [rawName, ...rawParams] = rawDescriptor.split(";");
  if (!rawName) {
    return null;
  }
  const params: Record<string, string> = {};

  for (const rawParam of rawParams) {
    const equalsIndex = rawParam.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = rawParam.slice(0, equalsIndex).toUpperCase();
    const value = stripSurroundingQuotes(rawParam.slice(equalsIndex + 1));
    params[key] = value;
  }

  return {
    name: rawName.toUpperCase(),
    params,
    value: unescapeText(rawValue)
  };
}

function getRequiredProperty(
  properties: ParsedContentLine[],
  name: string
): ParsedContentLine {
  const property = properties.find((entry) => entry.name === name);
  if (!property) {
    throw new Error(`Missing required property ${name}`);
  }

  return property;
}

function getRequiredValue(properties: ParsedContentLine[], name: string): string {
  return getRequiredProperty(properties, name).value;
}

function getOptionalValue(
  properties: ParsedContentLine[],
  name: string
): string | undefined {
  return properties.find((entry) => entry.name === name)?.value;
}

function parseDateValue(value: string, params: Record<string, string>): ParsedDateValue {
  if (params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(value)) {
    return {
      iso: `${parseDateOnly(value)}T00:00:00.000Z`,
      allDay: true
    };
  }

  const match = value.match(
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})(?<utc>Z)?$/
  );
  if (!match?.groups) {
    throw new Error(`Unsupported DATE-TIME value: ${value}`);
  }

  const components = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute),
    second: Number(match.groups.second)
  };

  if (match.groups.utc === "Z") {
    return {
      iso: new Date(
        Date.UTC(
          components.year,
          components.month - 1,
          components.day,
          components.hour,
          components.minute,
          components.second
        )
      ).toISOString(),
      allDay: false
    };
  }

  const timezone = params.TZID;
  return {
    iso: timezone
      ? timeZoneLocalToUtcIso(components, timezone)
      : new Date(
          Date.UTC(
            components.year,
            components.month - 1,
            components.day,
            components.hour,
            components.minute,
            components.second
          )
        ).toISOString(),
    allDay: false,
    ...(timezone === undefined ? {} : { timezone })
  };
}

function parseDateOnly(value: string): string {
  const match = value.match(/^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})$/);
  if (!match?.groups) {
    throw new Error(`Unsupported DATE value: ${value}`);
  }

  return `${match.groups.year}-${match.groups.month}-${match.groups.day}`;
}

function parseStatus(value: string | undefined): EventSummary["status"] | undefined {
  if (!value) {
    return undefined;
  }

  return STATUS_MAP[value.toUpperCase() as keyof typeof STATUS_MAP];
}

function normalizeAttendee(value: string): string {
  return value.replace(/^mailto:/i, "");
}

function stripSurroundingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function unescapeText(value: string): string {
  return value.replace(/\\[nN]|\\,|\\;|\\\\/g, (match) => {
    switch (match) {
      case "\\n":
      case "\\N":
        return "\n";
      case "\\,":
        return ",";
      case "\\;":
        return ";";
      case "\\\\":
        return "\\";
      default:
        return match;
    }
  });
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function optionalTextLines(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`${name}:${escapeText(value)}`];
}

function optionalStatusLines(status: EventSummary["status"]): string[] {
  return status === undefined ? [] : [`STATUS:${status.toUpperCase()}`];
}

function buildDateTimeLines(input: Omit<EventSummary, "etag">): string[] {
  if (input.allDay) {
    return [
      `DTSTART;VALUE=DATE:${formatDateOnly(input.start)}`,
      `DTEND;VALUE=DATE:${formatDateOnly(input.end)}`
    ];
  }

  if (input.timezone) {
    return [
      `DTSTART;TZID=${input.timezone}:${formatLocalDateTime(input.start, input.timezone)}`,
      `DTEND;TZID=${input.timezone}:${formatLocalDateTime(input.end, input.timezone)}`
    ];
  }

  return [
    `DTSTART:${formatUtcDateTime(input.start)}`,
    `DTEND:${formatUtcDateTime(input.end)}`
  ];
}

function formatDateOnly(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }

  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(
    date.getUTCHours()
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function formatLocalDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }

  const parts = getTimeZoneParts(date, timeZone);
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

function timeZoneLocalToUtcIso(
  components: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string
): string {
  const seed = new Date(
    Date.UTC(
      components.year,
      components.month - 1,
      components.day,
      components.hour,
      components.minute,
      components.second
    )
  );
  const initialOffset = getTimeZoneOffsetMs(seed, timeZone);
  let result = new Date(seed.getTime() - initialOffset);
  const correctedOffset = getTimeZoneOffsetMs(result, timeZone);

  if (correctedOffset !== initialOffset) {
    result = new Date(seed.getTime() - correctedOffset);
  }

  return result.toISOString();
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getTimeZoneParts(date, timeZone);
  const zonedTimestamp = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return zonedTimestamp - date.getTime();
}

function getTimeZoneParts(
  date: Date,
  timeZone: string
): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }

    return acc;
  }, {});

  return {
    year: values.year ?? "0000",
    month: values.month ?? "00",
    day: values.day ?? "00",
    hour: values.hour ?? "00",
    minute: values.minute ?? "00",
    second: values.second ?? "00"
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
