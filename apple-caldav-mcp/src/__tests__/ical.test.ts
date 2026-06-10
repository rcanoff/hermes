import test from "node:test";
import assert from "node:assert/strict";
import { buildEventIcs, parseEventIcs } from "../ical.js";

test("parseEventIcs maps VEVENT into normalized event shape", () => {
  const event = parseEventIcs("Work", "etag-1", `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1
SUMMARY:Buy milk
DESCRIPTION:2 liters
LOCATION:Grocery store
DTSTART:20260611T090000Z
DTEND:20260611T093000Z
ATTENDEE:mailto:alice@example.com
ATTENDEE:MAILTO:bob@example.com
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`);

  assert.deepEqual(event, {
    id: "event-1",
    calendar: "Work",
    etag: "etag-1",
    title: "Buy milk",
    description: "2 liters",
    location: "Grocery store",
    start: "2026-06-11T09:00:00.000Z",
    end: "2026-06-11T09:30:00.000Z",
    allDay: false,
    attendees: ["alice@example.com", "bob@example.com"],
    status: "confirmed"
  });
});

test("parseEventIcs supports all-day events with date-only values", () => {
  const event = parseEventIcs("Home", undefined, `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-2
SUMMARY:Day off
DTSTART;VALUE=DATE:20260612
DTEND;VALUE=DATE:20260613
STATUS:TENTATIVE
END:VEVENT
END:VCALENDAR`);

  assert.equal(event.start, "2026-06-12T00:00:00.000Z");
  assert.equal(event.end, "2026-06-13T00:00:00.000Z");
  assert.equal(event.allDay, true);
  assert.equal(event.status, "tentative");
});

test("parseEventIcs converts TZID date-times across a DST boundary", () => {
  const event = parseEventIcs("Work", "etag-berlin", `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-tzid
SUMMARY:Berlin shift
DTSTART;TZID=Europe/Berlin:20260329T013000
DTEND;TZID=Europe/Berlin:20260329T033000
END:VEVENT
END:VCALENDAR`);

  assert.equal(event.start, "2026-03-29T00:30:00.000Z");
  assert.equal(event.end, "2026-03-29T01:30:00.000Z");
  assert.equal(event.timezone, "Europe/Berlin");
  assert.equal(event.allDay, false);
});

test("buildEventIcs serializes normalized events back to ICS", () => {
  const raw = buildEventIcs({
    id: "event-3",
    calendar: "Work",
    title: "Write report",
    description: "Draft Q2 update",
    location: "Office",
    start: "2026-06-11T12:00:00.000Z",
    end: "2026-06-11T13:00:00.000Z",
    allDay: false,
    attendees: ["alice@example.com", "bob@example.com"],
    status: "cancelled"
  });

  assert.match(raw, /BEGIN:VEVENT/);
  assert.match(raw, /UID:event-3/);
  assert.match(raw, /SUMMARY:Write report/);
  assert.match(raw, /DESCRIPTION:Draft Q2 update/);
  assert.match(raw, /LOCATION:Office/);
  assert.match(raw, /DTSTART:20260611T120000Z/);
  assert.match(raw, /DTEND:20260611T130000Z/);
  assert.match(raw, /ATTENDEE:mailto:alice@example\.com/);
  assert.match(raw, /ATTENDEE:mailto:bob@example\.com/);
  assert.match(raw, /STATUS:CANCELLED/);
});

test("buildEventIcs and parseEventIcs round-trip escaped text fields", () => {
  const raw = buildEventIcs({
    id: "event-escaped",
    calendar: "Work",
    title: String.raw`Backslash \, comma, semicolon; title`,
    description: "Line 1\nLine 2, with comma; and slash \\",
    location: String.raw`Desk \, row 2; north`,
    start: "2026-06-11T12:00:00.000Z",
    end: "2026-06-11T13:00:00.000Z",
    allDay: false,
    attendees: ["mailto:carol@example.com"],
    status: "confirmed"
  });

  assert.match(raw, /SUMMARY:Backslash \\\\\\, comma\\, semicolon\\; title/);
  assert.match(raw, /DESCRIPTION:Line 1\\nLine 2\\, with comma\\; and slash \\\\/);
  assert.match(raw, /LOCATION:Desk \\\\\\, row 2\\; north/);

  const event = parseEventIcs("Work", undefined, raw);

  assert.equal(event.title, String.raw`Backslash \, comma, semicolon; title`);
  assert.equal(event.description, "Line 1\nLine 2, with comma; and slash \\");
  assert.equal(event.location, String.raw`Desk \, row 2; north`);
  assert.deepEqual(event.attendees, ["carol@example.com"]);
});
