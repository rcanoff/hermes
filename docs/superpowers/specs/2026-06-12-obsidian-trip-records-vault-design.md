# Trip Records Vault — Design

**Date:** 2026-06-12
**Status:** Approved
**Idea doc:** `2026-06-12-obsidian-trip-records-vault-idea.md`

## Concept: Hub and Spoke

Hermes gets one centralized, human-readable memory — an Obsidian-compatible markdown vault — and many satellite services that hold domain detail. The calendar is the first satellite; Todoist and others come later. Each record note in the vault is the hub for one real-world thing (starting with trips): it holds the canonical minimal facts and an index of every artifact that exists about it elsewhere.

**The general rule:** whenever Hermes creates an artifact in an external service on behalf of a record, it writes a pointer to that artifact (service, name, ID or URL) back into the record's note. The note answers "what exists and where does it live"; the satellite holds the enriched, service-native detail.

For the booking→calendar flow specifically: the note stores trip span, flight numbers, confirmation codes, and lodging/car references; the calendar event stores terminal, address, when to leave, and other operational detail — derived once and stored on the event, not duplicated in the note.

## Milestones

- **MVP (this spec):** the vault, the trip note format with the generic link pattern, trip resolution, the booking→calendar flow end-to-end, the `trip-records` skill, compose wiring, README documentation.
- **R1:** Todoist projects (e.g. packing lists, places-to-visit lists) as a second satellite. Slots into the `## Linked` pattern; gets its own spec.
- **R2:** TBD — candidates include record types beyond trips, iPhone sync (see "Deferred" below), and further satellites.

## Vault Layout & Bootstrap

- Create `data/vault/` on the host, which lands in the container at `/opt/data/vault`. Contents: `Trips/` and `Templates/Trip Template.md`.
- It is a plain folder of markdown files — Obsidian-compatible by construction. No `.obsidian/` config is created now; Obsidian adds it when the folder is first opened as a vault, with no migration needed.
- The vault is gitignored with the rest of `data/` and covered by the existing backup procedure.
- Set `OBSIDIAN_VAULT_PATH=/opt/data/vault` in the `hermes-gateway` service environment in `docker-compose.yml`. The existing `note-taking/obsidian` skill resolves the vault through this variable. Applying it requires a stack restart (`make down && make up`).

## Trip Note Format

One note per trip: `Trips/YYYY-MM Origin-Destination.md`, city names in the filename for readability (e.g. `2026-07 Berlin-Lisbon.md`).

```markdown
---
type: trip
status: planned        # planned | active | completed
origin: BER            # IATA code
destination: LIS       # IATA code
start: 2026-07-03      # ISO date
end: 2026-07-10
---

## Flights
- TP535 BER→LIS 2026-07-03 · conf ABC123 · calendar-uid: 9F2E…

## Lodging
- Airbnb Alfama · conf HMXYZ123 · calendar-uid: …

## Car rental

## Linked
- todoist: Packing list · https://todoist.com/…   (R1 example; section ships empty in MVP)
```

- Frontmatter is the queryable schema; `type: trip` keeps the vault open to future record types (a new folder plus a frontmatter convention, no schema change).
- Fact sections hold one bullet per canonical fact: identifier, route/place, date, confirmation code, and an inline `calendar-uid:` once an event exists — fact-level pointers belong on the fact line.
- `## Linked` holds trip-level artifacts not tied to one fact line (lists, documents, future satellites). The template includes it, empty.
- `Templates/Trip Template.md` mirrors this shape with placeholder values.

## Trip Resolution

When a booking artifact arrives, Hermes searches note frontmatter by destination and date overlap:

- Exactly one plausible match → use it silently.
- No match → offer to create the trip note.
- Multiple matches → ask the user which trip.

## The `trip-records` Skill

`data/skills/productivity/trip-records/SKILL.md` — a **thin orchestrator**. It owns only what is new and defers the rest:

| Concern | Owner |
|---|---|
| Vault layout, note format, trip resolution, link-back rule, trust hierarchy | `trip-records` (new) |
| File mechanics (read/search/create/patch notes) | `note-taking/obsidian` |
| Event shaping, merge-vs-create heuristics, duplicate prevention | `productivity/travel-bookings-to-calendar` |

The skill lives only in `data/skills/` like every other skill (gitignored, backup-covered); this spec is the tracked record of the design.

### End-to-end booking flow

1. Extract facts from the artifact. The screenshot is **authoritative** for dates, flight numbers, confirmation codes; Hermes never overrides these with searched values.
2. Resolve the trip note (rules above); create from the template if the user confirms.
3. Append the minimal fact line to the right section.
4. Web-search (Firecrawl) only missing **soft** details: terminal, address, typical leave-time.
5. Create or merge the calendar event per the `travel-bookings-to-calendar` skill.
6. Write the returned event UID back onto the fact line. A fact line without a UID means the event still needs creating.

## Error Handling

- **Stale pointers — trust the note, fix on error.** Hermes assumes stored UIDs are valid. If a calendar operation against a stored UID fails (event hand-deleted or hand-edited away), it reports the failure, offers to recreate the event, and updates the note line with the new UID. No verification reads, no reconciliation sweeps.
- **Failed writes.** If a calendar write fails mid-flow, the fact line stays in the note without a UID and Hermes says the event was not created. Never claim success on a failed write.

## Documentation & Verification

- Add a short section to `README.md` describing the vault, its container path, and the `trip-records` skill.
- Verification is a manual smoke test (the deliverable is markdown — a skill and a folder — so there is no code to unit test):
  1. Send a real booking screenshot through Hermes → expect one trip note, one calendar event, and the UID back-link on the fact line.
  2. Send a second artifact for the same trip → expect a merge into the existing event, not a duplicate, and a second fact line in the same note.

## Deferred

- **iPhone/Mac sync:** direct iCloud Drive sync from the Pi is not viable; Syncthing/CouchDB options add moving parts. Deferred — if the setup moves to a Mac mini, the vault can live in iCloud Drive natively. Local-only on the Pi for now.
- **Record types beyond trips** and **reconciliation jobs**: out of scope until a real need appears.
