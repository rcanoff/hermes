# Obsidian Trip Records Vault Idea

**Date:** 2026-06-12

## Goal

Give Hermes a searchable, human-readable database of personal records — starting with trips — that acts as the source of truth for canonical booking facts, and that links to enriched calendar events instead of duplicating their detail.

## Idea

Two kinds of memory with a link between them:

- **The record store** holds canonical, minimal facts: trip span, origin/destination, flight numbers, confirmation codes, lodging and car rental references. Small, structured, searchable — the source of truth for *what exists*.
- **The calendar** holds enriched, time-anchored detail: full flight event with terminal, address, when to leave — derived once and stored on the event, not in the record.

The piece that ties them together is the **back-link**: when Hermes creates a calendar event from a trip fact, it writes the calendar event UID back onto that fact. That prevents duplicate events, answers "did I already add my flight?", and lets Hermes re-read or update the event later.

## Chosen Storage: Obsidian-Compatible Markdown Vault

Options considered:

1. Custom SQLite-backed MCP service in the compose stack (like `apple-caldav-mcp`) — structured queries, but a new service to build and the data is only visible through Hermes.
2. Plain files in the Hermes workspace — cheap, but unstructured.
3. **Obsidian-compatible vault (chosen)** — one markdown note per trip with YAML frontmatter as the schema. Human-readable and browsable/editable on iPhone or Mac later; no custom service to build; Hermes edits the folder directly with file tools.

Rationale: at personal scale (a handful of trips, not thousands of rows), grep over frontmatter resolves "my Lisbon trip" fine, and the iPhone/Mac visibility is worth more than deterministic SQL queries. An Obsidian vault is just a folder of markdown files — Obsidian adds `.obsidian/` config when the folder is first opened, so a plain folder created now is reusable as a vault later with no migration.

## Trip Note Shape

One note per trip, e.g. `Trips/2026-07 Berlin-Lisbon.md`:

```markdown
---
type: trip
status: planned
origin: BER
destination: LIS
start: 2026-07-03
end: 2026-07-10
---

## Flights
- TP535 BER→LIS 2026-07-03 · conf ABC123 · calendar-uid: 9F2E…

## Lodging
- Airbnb Alfama · conf HMXYZ123 · calendar-uid: …

## Car rental
```

The `type` field keeps the design open: future record types (not just trips) are a new folder plus a frontmatter convention, no schema change.

## Trust Hierarchy for Details

- The user sends a screenshot of the booking (flight info, reservation). The screenshot is **authoritative** for dates, flight numbers, confirmation codes.
- Web search (Firecrawl) only fills missing soft details: terminal, typical leave-time, address.
- Hermes never invents or blindly trusts searched values for authoritative fields.

## What Hermes Already Supports

- `note-taking/obsidian` skill: filesystem-first vault work, resolves the vault via the `OBSIDIAN_VAULT_PATH` env var.
- `productivity/travel-bookings-to-calendar` skill: screenshot/booking artifact → extract details → one clean calendar event per reservation span, with merge-vs-create heuristics and duplicate prevention.
- `apple_calendar` MCP (local `apple-caldav-mcp` service) for calendar writes.
- Firecrawl for web search/extraction.
- Vision input for booking screenshots.

Missing piece: a custom **trip-records skill** that defines the vault layout, the trip note format, trip resolution ("which trip is the user talking about?"), and the calendar UID back-link workflow — composing the two existing skills.

## End-to-End Flow

Screenshot of flight info → Hermes extracts facts → finds or creates the trip note (search frontmatter by destination/date; one active match → use silently, none → offer to create, multiple → ask) → appends the minimal fact line with confirmation code → web-searches only missing soft details → creates/merges the calendar event per the travel-bookings skill → writes the event UID back into the note line.

## Sync Decision: Deferred

- Direct iCloud Drive ↔ Raspberry Pi sync is not viable: no official Linux client, unofficial clients are download-only and fragile, and Hermes needs two-way writes.
- Options evaluated: Syncthing + Möbius Sync on iOS (preferred for an always-on Pi hub); self-hosted CouchDB + obsidian-livesync (more moving parts); Mac as iCloud bridge (sleep-dependency, double sync layers).
- **Decision: defer.** The setup may move from the Raspberry Pi to a Mac mini, where the vault folder could live in iCloud Drive natively and sync to iPhone with zero extra services. For now the vault is local-only on the Pi.

## Proposed Implementation (not started)

1. Create `data/vault/` with `Trips/` and `Templates/Trip Template.md` (lands in the container at `/opt/data/vault`; persisted, gitignored runtime state, covered by the existing backup procedure).
2. Set `OBSIDIAN_VAULT_PATH=/opt/data/vault` in the `hermes-gateway` compose environment so the existing obsidian skill resolves it.
3. Add a custom skill `data/skills/productivity/trip-records/SKILL.md` defining note format, trip resolution, division of responsibility (note = canonical minimal facts, calendar = enriched detail), and the calendar-uid back-link rule, referencing the existing `obsidian` and `travel-bookings-to-calendar` skills.
4. Document the vault and skill in `README.md`.
5. Restart the stack (`make down && make up`) so the env var applies.

## Open Questions

- Vault folder name and note naming convention (current proposal: `data/vault/`, `Trips/YYYY-MM Origin-Destination.md`).
- Whether the trip-records skill should also be mirrored somewhere tracked in git, since `data/` is gitignored and only covered by backups.
- Stale-link handling: if a calendar event is hand-edited or deleted, the skill should verify the UID still exists before claiming the event is on the calendar.
- Later expansion beyond trips: which record type comes next, and whether the vault grows folders per type.
