# Trip Records Vault (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Hermes a centralized, Obsidian-compatible markdown vault of trip records that holds canonical booking facts and back-links to calendar events, wired up via a new `trip-records` skill.

**Architecture:** Hub-and-spoke per `docs/superpowers/implemented/specs/2026-06-12-obsidian-trip-records-vault-design.md` — one markdown note per trip in `data/vault/Trips/` is the hub (canonical facts + pointers); the calendar holds enriched detail. A new thin-orchestrator skill defines the note format, trip resolution, and the link-back rule, deferring file mechanics to the existing `obsidian` skill and event shaping to `travel-bookings-to-calendar`.

**Tech Stack:** Markdown + YAML frontmatter, Docker Compose env wiring. No application code; deliverables are files in the mounted `data/` dir plus compose/README edits.

**Important:** `data/` is gitignored by design (runtime state, covered by backups). Tasks 1 and 2 create files that are **never committed** — that is expected, not an oversight. Only Tasks 3, 4 produce commits.

---

### Task 1: Vault skeleton

**Files:**
- Create: `data/vault/Trips/` (empty folder; fine on disk since `data/` is never committed)
- Create: `data/vault/Templates/Trip Template.md`

- [ ] **Step 1: Create the folder structure**

```bash
mkdir -p "/home/rcanoff/hermes/data/vault/Trips" "/home/rcanoff/hermes/data/vault/Templates"
```

- [ ] **Step 2: Write the trip template**

Write `/home/rcanoff/hermes/data/vault/Templates/Trip Template.md` with exactly this content:

```markdown
---
type: trip
status: planned
origin: XXX
destination: XXX
start: 2026-01-01
end: 2026-01-01
---

## Flights

## Lodging

## Car rental

## Linked
```

Field semantics (defined in the spec): `status` is one of `planned | active | completed`; `origin`/`destination` are IATA codes; `start`/`end` are ISO dates. Fact sections get one bullet per canonical fact; `## Linked` holds trip-level pointers to artifacts in external services and ships empty in the MVP.

- [ ] **Step 3: Verify the structure**

```bash
find /home/rcanoff/hermes/data/vault
```

Expected output:

```
/home/rcanoff/hermes/data/vault
/home/rcanoff/hermes/data/vault/Trips
/home/rcanoff/hermes/data/vault/Templates
/home/rcanoff/hermes/data/vault/Templates/Trip Template.md
```

No commit — `data/` is gitignored.

---

### Task 2: The `trip-records` skill

**Files:**
- Create: `data/skills/productivity/trip-records/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p /home/rcanoff/hermes/data/skills/productivity/trip-records
```

- [ ] **Step 2: Write SKILL.md**

Write `/home/rcanoff/hermes/data/skills/productivity/trip-records/SKILL.md` with exactly this content:

````markdown
---
name: trip-records
description: Use when a travel booking artifact or trip-related request involves remembering trip facts — resolve or create the trip note in the records vault, append canonical facts (flights, lodging, car rental, confirmation codes), and back-link calendar events and other external artifacts into the note.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [travel, records, vault, obsidian, calendar, memory]
    related_skills: [obsidian, travel-bookings-to-calendar]
---

# Trip records

## Overview

The records vault is Hermes's centralized memory for personal records, starting with trips. One markdown note per trip is the **hub**: it holds the canonical minimal facts (trip span, flight numbers, confirmation codes, lodging and car references) and an index of every artifact that exists about the trip in external services. Satellite services hold the enriched detail — the calendar event carries terminal, address, and when to leave; the note does not duplicate that.

**The link-back rule:** whenever you create an artifact in an external service on behalf of a trip (a calendar event today; lists or documents in future services), write a pointer to it back into the trip note — service, name, and ID or URL. The note answers "what exists and where does it live."

## When to use

- The user shares a booking artifact (screenshot, PDF, capture) for a flight, lodging, or car rental.
- The user asks about a trip's facts: "what's my confirmation code", "did I already add my flight?", "when is my Lisbon trip?"
- You created a calendar event (or other external artifact) for a trip and need to record it.

Do not use for general calendar lookups with no trip context, or for note-taking unrelated to personal records.

## Vault layout

The vault root is `OBSIDIAN_VAULT_PATH` (`/opt/data/vault` in the container). Use the `obsidian` skill for all file mechanics — reading, searching, creating, and patching notes.

- `Trips/` — one note per trip, named `YYYY-MM Origin-Destination.md` with city names, e.g. `2026-07 Berlin-Lisbon.md`.
- `Templates/Trip Template.md` — the shape for new trip notes.

## Trip note format

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
- todoist: Packing list · https://todoist.com/…
```

- Frontmatter is the queryable schema. Search it to resolve trips.
- Fact sections hold one bullet per canonical fact: identifier, route or place, date, confirmation code, and an inline `calendar-uid:` once an event exists. Fact-level pointers live on the fact line.
- `## Linked` holds trip-level artifacts not tied to one fact line.
- A fact line **without** a `calendar-uid` means the calendar event has not been created yet.

## Trip resolution

When a booking artifact or trip reference arrives, search note frontmatter under `Trips/` by destination and date overlap:

- Exactly one plausible match → use it silently.
- No match → offer to create the trip note from `Templates/Trip Template.md`.
- Multiple matches → ask the user which trip.

## Booking → calendar workflow

1. **Extract facts from the artifact.** The artifact (screenshot, PDF) is **authoritative** for dates, flight numbers, and confirmation codes. Never override these with searched values; never invent them.
2. **Resolve the trip note** (rules above).
3. **Append the minimal fact line** to the right section (`## Flights`, `## Lodging`, `## Car rental`).
4. **Web-search only missing soft details** — terminal, address, typical leave-time — for the calendar event. Soft details go on the event, not in the note.
5. **Create or merge the calendar event** following the `travel-bookings-to-calendar` skill (one event per reservation span, merge-vs-create heuristics, duplicate prevention).
6. **Write the returned event UID back onto the fact line** as `calendar-uid: <uid>`.

## Error handling

- **Trust the note; fix on error.** Assume stored UIDs are valid — no verification reads, no reconciliation sweeps. If a calendar operation against a stored UID fails (the event was hand-edited or deleted), report the failure, offer to recreate the event, and update the note line with the new UID.
- **Failed writes.** If a calendar write fails mid-flow, leave the fact line in the note without a UID and tell the user the event was not created. Never claim success on a failed write.

## Verification checklist

- [ ] Authoritative facts (dates, flight numbers, confirmation codes) came from the artifact, not from search
- [ ] Resolved the trip note before writing (silent on one match, asked on many, offered create on none)
- [ ] Fact line appended to the correct section with the confirmation code
- [ ] Calendar event created or merged per `travel-bookings-to-calendar`
- [ ] Event UID written back onto the fact line after a confirmed successful write
- [ ] Any external-artifact creation recorded in the note (fact line or `## Linked`)
````

- [ ] **Step 3: Verify the skill file exists and frontmatter parses**

```bash
head -15 /home/rcanoff/hermes/data/skills/productivity/trip-records/SKILL.md
```

Expected: the YAML frontmatter block starting with `name: trip-records`.

No commit — `data/` is gitignored.

---

### Task 3: Compose wiring for `OBSIDIAN_VAULT_PATH`

**Files:**
- Modify: `docker-compose.yml:20-31` (the `hermes-gateway` `environment:` block)

- [ ] **Step 1: Add the env var**

In `docker-compose.yml`, in the `hermes-gateway` service `environment:` block, add one line after `OPENAI_BASE_URL`:

```yaml
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENAI_BASE_URL: ${OPENAI_BASE_URL:-}
      OBSIDIAN_VAULT_PATH: /opt/data/vault
```

The value is a fixed container path (the host side is whatever `HERMES_DATA_DIR` points at, mounted at `/opt/data`), so no `.env` entry is needed.

- [ ] **Step 2: Verify compose config resolves**

```bash
cd /home/rcanoff/hermes && make config 2>/dev/null | grep OBSIDIAN_VAULT_PATH || docker compose config | grep OBSIDIAN_VAULT_PATH
```

Expected output contains:

```
      OBSIDIAN_VAULT_PATH: /opt/data/vault
```

- [ ] **Step 3: Commit**

```bash
cd /home/rcanoff/hermes && git add docker-compose.yml && git commit -m "feat: wire OBSIDIAN_VAULT_PATH for trip records vault"
```

---

### Task 4: README documentation

**Files:**
- Modify: `README.md` (add a new `##` section immediately before the existing `## macOS validation steps` section, currently line 268)

- [ ] **Step 1: Add the docs section**

Insert this section into `README.md` before `## macOS validation steps`:

```markdown
## Trip records vault

Hermes keeps a centralized memory of personal records — currently trips — in an
Obsidian-compatible markdown vault at `data/vault/` (mounted in the container at
`/opt/data/vault`, resolved by skills via `OBSIDIAN_VAULT_PATH`).

One note per trip lives in `Trips/` (named `YYYY-MM Origin-Destination.md`) and holds
canonical booking facts: trip span, flight numbers, confirmation codes, lodging and
car rental references. Enriched detail (terminal, address, when to leave) lives on
the linked calendar event, and each event's UID is written back onto the note's fact
line to prevent duplicates.

The workflow is defined by the `productivity/trip-records` skill in `data/skills/`,
which composes the existing `note-taking/obsidian` and
`productivity/travel-bookings-to-calendar` skills. Design spec:
`docs/superpowers/implemented/specs/2026-06-12-obsidian-trip-records-vault-design.md`.

The vault is plain markdown — open the folder in Obsidian later for browsing on
Mac/iPhone (sync is deferred; the vault is local-only on the Pi for now). It is part
of `data/`, so the existing backup procedure covers it.
```

- [ ] **Step 2: Verify placement**

```bash
grep -n "^## " /home/rcanoff/hermes/README.md | sed -n '8,12p'
```

Expected: `## Trip records vault` appears between `## Apple Calendar MCP setup` and `## macOS validation steps`.

- [ ] **Step 3: Commit**

```bash
cd /home/rcanoff/hermes && git add README.md && git commit -m "docs: document trip records vault and skill"
```

---

### Task 5: Restart stack and verify wiring

**Files:** none (operational)

- [ ] **Step 1: Restart the stack**

```bash
cd /home/rcanoff/hermes && make down && make up
```

Expected: compose recreates `hermes` and `apple-caldav-mcp` containers without errors.

- [ ] **Step 2: Verify the env var inside the container**

```bash
docker exec hermes printenv OBSIDIAN_VAULT_PATH
```

Expected output:

```
/opt/data/vault
```

- [ ] **Step 3: Verify the vault is visible from the container**

```bash
docker exec hermes ls /opt/data/vault/Templates
```

Expected output:

```
Trip Template.md
```

---

### Manual smoke test (user-driven, after Task 5)

Not an executable plan step — requires a real booking screenshot sent through Hermes (Telegram or dashboard):

1. Send a booking screenshot → expect one new note in `Trips/`, one calendar event, and `calendar-uid:` on the fact line.
2. Send a second artifact for the same trip → expect a second fact line in the same note and a merge into the existing event, not a duplicate.
