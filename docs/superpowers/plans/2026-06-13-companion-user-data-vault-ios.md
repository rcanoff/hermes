# Companion User Data Vault — iOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the assistant-companion iOS app so location is a standalone feature — one-off share and continuous background sharing write to `/data/location/events`, decoupled from chat.

**Architecture:** `LocationSharingView` owns user-facing sharing policy (app-local state). `LocationSyncService` geocodes via `CLGeocoder` and POSTs events. `ChatViewModel` no longer knows about location. Background sharing uses significant-change monitoring plus an optional timer fallback.

**Tech Stack:** SwiftUI, Swift Concurrency, URLSession, CoreLocation, CLGeocoder, XCTest

**Spec:** `docs/superpowers/specs/2026-06-13-companion-user-data-vault-design.md`  
**OpenAPI:** `docs/superpowers/specs/messaging-api.openapi.yaml` (v1.5.0)  
**Prerequisite:** Base app implemented per `docs/superpowers/implemented/plans/2026-06-12-assistant-companion-plan.md` (auth, conversations, chat, SSE). Backend v1.5.0 deployed before live testing.

**Codebase location:** separate machine — paths below are relative to the `assistant-companion` Xcode project root.

---

## File Structure

```
assistant-companion/assistant-companion/
  Models/
    LocationEventPayload.swift       — NEW: ingest payload (replaces LocationPayload)
    LocationEvent.swift              — NEW: GET response model
    LocationTrigger.swift            — NEW: manual | significant_change | interval
  Services/
    APIClient.swift                  — add postLocationEvent, getLatestLocation, getLocationHistory
    LocationService.swift            — refactor: one-off + continuous background
    LocationSyncService.swift        — NEW: geocode + POST
    LocationSharingStore.swift       — NEW: UserDefaults isLiveSharingEnabled
  ViewModels/
    LocationSharingViewModel.swift   — NEW
    ChatViewModel.swift              — REMOVE all location logic
  Views/
    LocationSharingView.swift        — NEW
    ChatView.swift                   — REMOVE LocationIndicator, location bindings
    MessageComposer.swift            — REMOVE location mode picker
    RootView.swift                   — add Location tab or navigation entry
  Info.plist                         — background location keys

assistant-companion/assistant-companionTests/
  LocationSyncServiceTests.swift     — NEW (mock APIClient)
  LocationSharingViewModelTests.swift — NEW
  APIClientLocationTests.swift       — NEW

REMOVE or gut:
  Views/LocationIndicator.swift
  Models/LocationPayload.swift       — replace with LocationEventPayload
  LocationMode enum usage in chat
```

---

## Task 1: Models aligned with OpenAPI v1.5.0

**Files:**
- Create: `Models/LocationTrigger.swift`
- Create: `Models/LocationEventPayload.swift`
- Create: `Models/LocationEvent.swift`
- Delete: `Models/LocationPayload.swift`

- [ ] **Step 1: Create LocationTrigger**

```swift
import Foundation

enum LocationTrigger: String, Codable, CaseIterable {
    case manual
    case significant_change
    case interval
}
```

- [ ] **Step 2: Create LocationEventPayload**

```swift
import Foundation

struct LocationEventPayload: Codable {
    let lat: Double
    let lon: Double
    let accuracy_m: Double
    let timestamp: String
    let trigger: String
    let source: String
    let address: String?

    init(location: CLLocation, trigger: LocationTrigger, address: String?) {
        self.lat = location.coordinate.latitude
        self.lon = location.coordinate.longitude
        self.accuracy_m = location.horizontalAccuracy
        self.timestamp = ISO8601DateFormatter.milliseconds.string(from: location.timestamp)
        self.trigger = trigger.rawValue
        self.source = "ios"
        self.address = address
    }
}
```

Add `ISO8601DateFormatter.milliseconds` extension matching backend pattern `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`.

- [ ] **Step 3: Create LocationEvent response model**

```swift
struct LocationEvent: Codable, Identifiable {
    let id: String
    let user_id: String
    let lat: Double
    let lon: Double
    let accuracy_m: Double
    let timestamp: String
    let trigger: String
    let source: String
    let address: String?
    let address_source: String?
    let address_status: String
    let created_at: String
}

struct LocationEventList: Codable {
    let events: [LocationEvent]
}
```

- [ ] **Step 4: Delete LocationPayload.swift and LocationMode enum**

- [ ] **Step 5: Build**

`Cmd+B` — Expected: compile errors in chat files (fixed in later tasks)

- [ ] **Step 6: Commit**

```bash
git add assistant-companion/assistant-companion/Models/
git commit -m "feat(ios): add location event models for data vault API"
```

---

## Task 2: APIClient location endpoints

**Files:**
- Modify: `Services/APIClient.swift`
- Create: `assistant-companionTests/APIClientLocationTests.swift`

- [ ] **Step 1: Write APIClient tests**

Mock `URLProtocol` to assert:
- `POST /data/location/events` sends correct JSON keys (`trigger`, optional `address`)
- `GET /data/location/latest` decodes `LocationEvent`
- 404 on latest maps to `nil` or typed error

- [ ] **Step 2: Add APIClient methods**

```swift
func postLocationEvent(_ payload: LocationEventPayload) async throws {
    var request = try authorizedRequest(path: "/data/location/events", method: "POST")
    request.httpBody = try JSONEncoder().encode(payload)
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 204 else {
        throw APIError.unexpectedStatus
    }
}

func getLatestLocationEvent() async throws -> LocationEvent? {
    var request = try authorizedRequest(path: "/data/location/latest", method: "GET")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    if http.statusCode == 404 { return nil }
    guard http.statusCode == 200 else { throw APIError.unexpectedStatus }
    return try JSONDecoder().decode(LocationEvent.self, from: data)
}

func getLocationHistory(limit: Int = 20, before: String? = nil) async throws -> [LocationEvent] {
    var components = URLComponents()
    components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
    if let before { components.queryItems?.append(URLQueryItem(name: "before", value: before)) }
    let path = "/data/location/events" + (components.percentEncodedQuery.map { "?\($0)" } ?? "")
    var request = try authorizedRequest(path: path, method: "GET")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        throw APIError.unexpectedStatus
    }
    return try JSONDecoder().decode(LocationEventList.self, from: data).events
}
```

- [ ] **Step 3: Remove old conversation location methods**

Delete any `postConversationLocation`, `deleteConversationLocation`, etc.

- [ ] **Step 4: Run tests**

`Cmd+U` — APIClientLocationTests pass

- [ ] **Step 5: Commit**

```bash
git add assistant-companion/assistant-companion/Services/APIClient.swift assistant-companion/assistant-companionTests/
git commit -m "feat(ios): add /data/location APIClient methods"
```

---

## Task 3: LocationSyncService (geocode + POST)

**Files:**
- Create: `Services/LocationSyncService.swift`
- Create: `assistant-companionTests/LocationSyncServiceTests.swift`

- [ ] **Step 1: Write failing test**

Mock `APIClient` and stub `CLGeocoder` wrapper protocol. Assert:
- Geocode success → POST includes `address`
- Geocode failure → POST omits `address` key (or sends null)

- [ ] **Step 2: Implement LocationSyncService**

```swift
@MainActor
final class LocationSyncService {
    private let apiClient: APIClient
    private let geocoder: Geocoding

    init(apiClient: APIClient, geocoder: Geocoding = CLGeocoderWrapper()) {
        self.apiClient = apiClient
        self.geocoder = geocoder
    }

    func sync(_ location: CLLocation, trigger: LocationTrigger) async throws {
        let address = try? await geocoder.reverseGeocode(location)
        let payload = LocationEventPayload(location: location, trigger: trigger, address: address)
        try await apiClient.postLocationEvent(payload)
    }
}
```

Introduce `Geocoding` protocol for testability.

- [ ] **Step 3: Run tests and commit**

```bash
git add assistant-companion/assistant-companion/Services/LocationSyncService.swift assistant-companion/assistant-companionTests/LocationSyncServiceTests.swift
git commit -m "feat(ios): add LocationSyncService with CLGeocoder"
```

---

## Task 4: LocationService background refactor

**Files:**
- Modify: `Services/LocationService.swift`
- Create: `Services/LocationSharingStore.swift`

- [ ] **Step 1: LocationSharingStore**

```swift
enum LocationSharingStore {
    private static let key = "isLiveSharingEnabled"

    static var isLiveSharingEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}
```

- [ ] **Step 2: Refactor LocationService**

Responsibilities:
- `requestOneOffLocation() async throws -> CLLocation` — `requestLocation` delegate pattern
- `startContinuousSharing(onUpdate: @escaping (CLLocation, LocationTrigger) -> Void)` — significant changes + 15 min timer fallback
- `stopContinuousSharing()`
- Skip posting when moved < 100m since last synced fix (track last synced coords in service)

On app launch: if `LocationSharingStore.isLiveSharingEnabled`, call `startContinuousSharing`.

- [ ] **Step 3: Build and commit**

```bash
git add assistant-companion/assistant-companion/Services/LocationService.swift assistant-companion/assistant-companion/Services/LocationSharingStore.swift
git commit -m "feat(ios): refactor LocationService for standalone background sharing"
```

---

## Task 5: LocationSharingViewModel + View

**Files:**
- Create: `ViewModels/LocationSharingViewModel.swift`
- Create: `Views/LocationSharingView.swift`
- Create: `assistant-companionTests/LocationSharingViewModelTests.swift`

- [ ] **Step 1: ViewModel**

```swift
@MainActor
final class LocationSharingViewModel: ObservableObject {
    @Published var isLiveSharingEnabled: Bool
    @Published var statusMessage: String?
    @Published var lastSharedAt: String?

    private let locationService: LocationService
    private let syncService: LocationSyncService
    private let apiClient: APIClient

    init(...) {
        self.isLiveSharingEnabled = LocationSharingStore.isLiveSharingEnabled
    }

    func shareNow() async { /* requestOneOff → sync manual → statusMessage */ }
    func setLiveSharing(_ enabled: Bool) async { /* start/stop + persist store */ }
    func refreshStatus() async { /* GET /data/location/latest for display */ }
}
```

- [ ] **Step 2: LocationSharingView UI**

- **Share now** button (prominent)
- **Share live location** toggle
- Status text: last shared timestamp from `GET /data/location/latest`
- Error alert on permission denied

No chat references.

- [ ] **Step 3: ViewModel tests**

Test `setLiveSharing(true)` persists store and starts service (inject mocks).

- [ ] **Step 4: Commit**

```bash
git add assistant-companion/assistant-companion/ViewModels/LocationSharingViewModel.swift assistant-companion/assistant-companion/Views/LocationSharingView.swift assistant-companion/assistant-companionTests/
git commit -m "feat(ios): add standalone LocationSharingView"
```

---

## Task 6: Remove location from chat

**Files:**
- Modify: `ViewModels/ChatViewModel.swift`
- Modify: `Views/ChatView.swift`
- Modify: `Views/MessageComposer.swift`
- Delete: `Views/LocationIndicator.swift`

- [ ] **Step 1: Strip ChatViewModel**

Remove:
- `locationMode` property
- `LocationService` dependency
- Pre-send location POST logic
- Live location loop tied to conversation lifecycle

Send flow becomes: `POST /conversations/:id/messages` only.

- [ ] **Step 2: Simplify MessageComposer**

Text field + send button only. No location menu.

- [ ] **Step 3: Simplify ChatView**

Remove `LocationIndicator` and location bindings.

- [ ] **Step 4: Delete LocationIndicator.swift**

- [ ] **Step 5: Build and run chat tests**

`Cmd+U` — existing chat tests still pass

- [ ] **Step 6: Commit**

```bash
git add assistant-companion/assistant-companion/ViewModels/ChatViewModel.swift assistant-companion/assistant-companion/Views/
git rm assistant-companion/assistant-companion/Views/LocationIndicator.swift
git commit -m "refactor(ios): decouple chat from location sharing"
```

---

## Task 7: App navigation

**Files:**
- Modify: `Views/RootView.swift` or `ConversationListView.swift`

- [ ] **Step 1: Add Location entry point**

Use a `TabView`:
- Tab 1: Conversations (existing)
- Tab 2: Location (`LocationSharingView`)

Or: toolbar button on `ConversationListView` presenting `LocationSharingView` as a sheet. Prefer **TabView** for a standalone feature.

- [ ] **Step 2: Wire dependencies**

Inject shared `APIClient` into `LocationSharingViewModel`.

- [ ] **Step 3: Build and manual smoke test**

Login → Location tab → Share now → verify 204 against backend

- [ ] **Step 4: Commit**

```bash
git add assistant-companion/assistant-companion/Views/RootView.swift
git commit -m "feat(ios): add Location tab to app shell"
```

---

## Task 8: Permissions and Info.plist

**Files:**
- Modify: `Info.plist`

- [ ] **Step 1: Add usage descriptions**

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Share your location with Hermes when you tap Share now.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Keep Hermes updated with your location while live sharing is enabled.</string>
```

- [ ] **Step 2: Enable background mode**

Xcode → Signing & Capabilities → Background Modes → Location updates

- [ ] **Step 3: Request permissions in ViewModel**

- One-off: `requestWhenInUseAuthorization`
- Live sharing: `requestAlwaysAuthorization` before starting continuous

- [ ] **Step 4: Commit**

```bash
git add assistant-companion/
git commit -m "feat(ios): add location permissions and background mode"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: One-off share**

Share now → confirm `POST /data/location/events` with `trigger: manual` and optional `address`

- [ ] **Step 2: Live sharing**

Enable toggle → walk/drive or simulate location → confirm `significant_change` or `interval` events

- [ ] **Step 3: Disable live sharing**

Toggle off → confirm no more POSTs; backend still has last event

- [ ] **Step 4: Chat unaffected**

Send chat message → confirm no location API calls

- [ ] **Step 5: Hermes integration (manual)**

Ask Hermes "where am I?" from companion chat or Telegram → four-line response via MCP

- [ ] **Step 6: Final commit**

```bash
git commit -m "chore(ios): verify companion location vault integration"
```

---

## Spec Coverage Checklist

| Spec requirement | Task |
|-----------------|------|
| Standalone location UI | Tasks 5, 7 |
| One-off share (`trigger: manual`) | Tasks 4, 5 |
| Continuous background sharing | Tasks 4, 5, 8 |
| App-owned sharing policy (no server mode) | Tasks 4, 5 |
| CLGeocoder before POST | Task 3 |
| Remove conversation location from chat | Task 6 |
| OpenAPI v1.5.0 payload shape | Tasks 1, 2 |
| No wait for backend enrichment | Task 3 |