import test from "node:test";
import assert from "node:assert/strict";
import { buildToolHandlers } from "../tools.js";
import type { CaldavAdapter } from "../caldav.js";
import type { EventSummary } from "../types.js";

const sampleEvent: EventSummary = {
  id: "event-1",
  calendar: "Home",
  etag: '"etag-1"',
  title: "Doctor appointment",
  description: "Annual checkup",
  location: "Clinic",
  start: "2026-06-11T09:00:00.000Z",
  end: "2026-06-11T09:30:00.000Z",
  allDay: false,
  timezone: "Europe/Berlin",
  attendees: ["alice@example.com"],
  status: "confirmed"
};

test("list_calendars delegates to the adapter", async () => {
  const adapter: CaldavAdapter = {
    listCalendars: async () => [{ id: "1", name: "Home", url: "u" }],
    listEvents: async () => [],
    getEvent: async () => {
      throw new Error("unused");
    },
    createEvent: async () => {
      throw new Error("unused");
    },
    updateEvent: async () => {
      throw new Error("unused");
    },
    deleteEvent: async () => {}
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.list_calendars({});

  assert.equal(result[0]?.name, "Home");
});

test("list_events delegates calendar and range to the adapter", async () => {
  let call: { calendar: string; from?: string; to?: string } | undefined;
  const adapter: CaldavAdapter = {
    listCalendars: async () => [],
    listEvents: async (calendar, from, to) => {
      call = {
        calendar,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to })
      };
      return [sampleEvent];
    },
    getEvent: async () => {
      throw new Error("unused");
    },
    createEvent: async () => {
      throw new Error("unused");
    },
    updateEvent: async () => {
      throw new Error("unused");
    },
    deleteEvent: async () => {}
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.list_events({
    calendar: "Home",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-30T23:59:59.000Z"
  });

  assert.deepEqual(call, {
    calendar: "Home",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-06-30T23:59:59.000Z"
  });
  assert.deepEqual(result, [sampleEvent]);
});

test("get_event delegates calendar and id to the adapter", async () => {
  let call: { calendar: string; id: string } | undefined;
  const adapter: CaldavAdapter = {
    listCalendars: async () => [],
    listEvents: async () => [],
    getEvent: async (calendar, id) => {
      call = { calendar, id };
      return sampleEvent;
    },
    createEvent: async () => {
      throw new Error("unused");
    },
    updateEvent: async () => {
      throw new Error("unused");
    },
    deleteEvent: async () => {}
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.get_event({
    calendar: "Home",
    id: "event-1"
  });

  assert.deepEqual(call, { calendar: "Home", id: "event-1" });
  assert.deepEqual(result, sampleEvent);
});

test("create_event passes the event through to the adapter", async () => {
  let call: EventSummary | undefined;
  const adapter: CaldavAdapter = {
    listCalendars: async () => [],
    listEvents: async () => [],
    getEvent: async () => {
      throw new Error("unused");
    },
    createEvent: async (input) => {
      call = input;
      return input;
    },
    updateEvent: async () => {
      throw new Error("unused");
    },
    deleteEvent: async () => {}
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.create_event(sampleEvent);

  assert.deepEqual(call, sampleEvent);
  assert.deepEqual(result, sampleEvent);
});

test("update_event passes the event through to the adapter", async () => {
  let call: EventSummary | undefined;
  const adapter: CaldavAdapter = {
    listCalendars: async () => [],
    listEvents: async () => [],
    getEvent: async () => {
      throw new Error("unused");
    },
    createEvent: async () => {
      throw new Error("unused");
    },
    updateEvent: async (input) => {
      call = input;
      return input;
    },
    deleteEvent: async () => {}
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.update_event(sampleEvent);

  assert.deepEqual(call, sampleEvent);
  assert.deepEqual(result, sampleEvent);
});

test("delete_event delegates calendar id and etag to the adapter", async () => {
  let call: { calendar: string; id: string; etag?: string } | undefined;
  const adapter: CaldavAdapter = {
    listCalendars: async () => [],
    listEvents: async () => [],
    getEvent: async () => {
      throw new Error("unused");
    },
    createEvent: async () => {
      throw new Error("unused");
    },
    updateEvent: async () => {
      throw new Error("unused");
    },
    deleteEvent: async (calendar, id, etag) => {
      call = {
        calendar,
        id,
        ...(etag === undefined ? {} : { etag })
      };
    }
  };
  const handlers = buildToolHandlers(adapter);

  const result = await handlers.delete_event({
    calendar: "Home",
    id: "event-1",
    etag: '"etag-1"'
  });

  assert.equal(result, undefined);
  assert.deepEqual(call, {
    calendar: "Home",
    id: "event-1",
    etag: '"etag-1"'
  });
});
