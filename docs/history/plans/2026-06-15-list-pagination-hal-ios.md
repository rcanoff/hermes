# List Pagination (HAL `_links`) — iOS Client Reference Plan

> **NOT IMPLEMENTED IN `hermes`.** This document is a **reference plan** for the `assistant-companion` iOS repo. Agents working in `hermes` must **not** execute these steps. Implement backend only per `2026-06-15-list-pagination-hal-backend.md`.

> **Contract source of truth:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.6.0). Client models must match OpenAPI schemas.

**Goal:** Update `assistant-companion` to decode and navigate HAL-paginated list responses for **all three REST list endpoints** against messaging-api **v1.6.0**.

**Architecture:** Shared `HalLinks` type and `APIClient.get(href:)`. ViewModels: `_links.next` for conversation list and location history; `_links.prev` for chat older messages.

**Tech Stack:** SwiftUI, Swift Concurrency, URLSession, XCTest

**Spec:** `docs/history/specs/2026-06-15-list-pagination-hal-design.md` (iOS section)  
**Backend plan (hermes repo):** `docs/history/plans/2026-06-15-list-pagination-hal-backend.md`  
**Prerequisite:** Base app per `docs/history/implemented/plans/2026-06-12-assistant-companion-plan.md` and backend parity per `2026-06-13-assistant-companion-backend-parity.md`

**App root:** `assistant-companion/assistant-companion/` (**external repository**)

---

## Breaking Change Summary

| Endpoint | Old decode | New decode |
|----------|------------|------------|
| `GET /conversations` | `[Conversation]` | `ConversationListResponse` |
| `GET /conversations/:id/messages` | `[Message]` | `MessageListResponse` |
| `GET /data/location/events` | `LocationEventList { events }` | `LocationEventListResponse` |

Until the iOS build ships, **do not deploy backend v1.6.0** to production for companion users.

---

## File Structure

```
assistant-companion/assistant-companion/
  Models/
    HalLinks.swift                    — NEW
    ConversationListResponse.swift    — NEW
    MessageListResponse.swift         — NEW
    LocationEventListResponse.swift   — NEW (replaces events-only LocationEventList)
  Services/
    APIClient.swift                   — MODIFY: get(path:) + get(href:); getLocationHistory → HAL
  ViewModels/
    ConversationListViewModel.swift   — MODIFY: paginated load + loadMore
    ChatViewModel.swift               — MODIFY: tail load + loadOlder
    LocationHistoryViewModel.swift    — MODIFY (if exists): loadMore via _links.next
  Views/
    ConversationListView.swift        — MODIFY (optional): load more on appear
    ChatView.swift                    — MODIFY (optional): scroll-to-top trigger
    LocationSharingView.swift         — MODIFY (optional): history pagination

assistant-companion/assistant-companionTests/
  HalLinksDecodingTests.swift           — NEW
  ConversationListResponseTests.swift   — NEW
  MessageListResponseTests.swift        — NEW
  LocationEventListResponseTests.swift  — NEW
  APIClientHrefTests.swift              — NEW (mock URLProtocol)
  ChatViewModelPaginationTests.swift    — NEW
```

---

## Task 1: HAL models

Mirror OpenAPI schemas `HalLink`, `HalLinks`, `ConversationListResponse`, `MessageListResponse`, `LocationEventListResponse`.

- [ ] Add `HalLinks.swift`, list response types with `CodingKeys` mapping `_links` → `links`
- [ ] XCTest fixtures from OpenAPI examples

---

## Task 2: APIClient href following

- [ ] `get<T>(href: String)` resolves relative path against `baseURL`
- [ ] Update list fetch methods to decode paginated response types (not bare arrays)

---

## Task 3: ConversationListViewModel

- [ ] Initial `GET /conversations` → `ConversationListResponse`
- [ ] `loadMoreIfNeeded()` follows `_links.next.href`

---

## Task 4: ChatViewModel

- [ ] Initial `GET /conversations/:id/messages` → tail page
- [ ] `loadOlderIfAvailable()` follows `_links.prev.href`, prepends, dedupes by id

---

## Task 5: Location history

- [ ] Replace `LocationEventList` with `LocationEventListResponse`
- [ ] `getLocationHistory` / load more via `_links.next`

---

## Task 6: Integration verification (assistant-companion repo)

| Check | Expected |
|-------|----------|
| Conversation list opens | First page decodes |
| Open chat | Tail messages load |
| Long thread | Older messages via `prev` (if UI wired) |
| Location history | HAL decode + optional load more |
| Send message | SSE unchanged |

---

## Deploy Coordination

| Step | Repo |
|------|------|
| Backend v1.6.0 + OpenAPI | `hermes` |
| iOS client update | `assistant-companion` |
| TestFlight before/at backend deploy | `assistant-companion` |
| Restart messaging-api | `hermes` ops |