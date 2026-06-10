export type CalendarSummary = {
  id: string;
  name: string;
  url: string;
};

export type EventSummary = {
  id: string;
  calendar: string;
  etag?: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone?: string;
  attendees: string[];
  status?: "confirmed" | "tentative" | "cancelled";
};
