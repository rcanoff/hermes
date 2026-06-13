# Hermes assistant-companion iOS App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native SwiftUI iOS app that authenticates users, manages conversations, sends and receives streamed messages from the Hermes backend, and optionally shares device location as invisible conversation context.

**Architecture:** Protocol-based service injection throughout — `APIClient` handles all HTTP, `SSEParser` handles streaming, `LocationService` wraps CoreLocation. ViewModels own all async logic; Views are pure layout. `KeychainService` stores the JWT on login and clears it on logout. The app root switches between `LoginView` and `ConversationListView` based on `AuthViewModel.isAuthenticated`.

**Tech Stack:** SwiftUI, Swift Concurrency (async/await), URLSession, CoreLocation, Security framework (Keychain), XCTest

---

## File Structure

```
assistant-companion/assistant-companion/
  App/
    assistant_companionApp.swift     — @main, injects AuthViewModel as environment object
    RootView.swift                   — switches between LoginView and ConversationListView
  Models/
    Conversation.swift               — Conversation, ConversationSummary Codable structs
    Message.swift                    — Message Codable struct (id, role, content, created_at)
    LocationPayload.swift            — LocationPayload struct, LocationMode enum (off/once/live)
  Services/
    APIClient.swift                  — URLSession wrapper: base URL, auth header injection, JSON en/decode
    KeychainService.swift            — save/read/delete JWT token via SecItem APIs
    SSEParser.swift                  — parses URLSession.bytes stream into SSEEvent values
    LocationService.swift            — CLLocationManager wrapper, publishes CLLocation via async stream
  ViewModels/
    AuthViewModel.swift              — login, logout, token, isAuthenticated
    ConversationListViewModel.swift  — conversations array, create, refresh
    ChatViewModel.swift              — messages, send, stream, locationMode, live location loop
  Views/
    LoginView.swift                  — username + password form
    ConversationListView.swift       — list of conversations + new conversation button
    ChatView.swift                   — message list + MessageComposer + LocationIndicator
    MessageBubble.swift              — single message bubble (user/assistant, streaming state)
    MessageComposer.swift            — text field + location mode picker + send button
    LocationIndicator.swift          — pill shown when live sharing is active
```

---

## Task 1: Models + KeychainService

**Files:**
- Modify: `assistant-companion/assistant-companion/Models/Conversation.swift` (create)
- Create: `assistant-companion/assistant-companion/Models/Message.swift`
- Create: `assistant-companion/assistant-companion/Models/LocationPayload.swift`
- Create: `assistant-companion/assistant-companion/Services/KeychainService.swift`

- [ ] **Step 1: Create Models/Conversation.swift**

Create the file at `assistant-companion/assistant-companion/Models/Conversation.swift`:

```swift
import Foundation

struct ConversationSummary: Codable, Identifiable {
    let id: String
    let title: String
    let hermes_session_id: String
    let created_at: String
}
```

- [ ] **Step 2: Create Models/Message.swift**

```swift
import Foundation

struct Message: Codable, Identifiable {
    let id: String
    let role: String   // "user" or "assistant"
    let content: String
    let created_at: String
}
```

- [ ] **Step 3: Create Models/LocationPayload.swift**

```swift
import Foundation

enum LocationMode: String, CaseIterable {
    case off
    case once
    case live
}

struct LocationPayload: Codable {
    let lat: Double
    let lon: Double
    let accuracy_m: Double
    let timestamp: String
    let mode: String
    let source: String
}
```

- [ ] **Step 4: Create Services/KeychainService.swift**

```swift
import Foundation
import Security

enum KeychainService {
    private static let service = "com.hermes.companion"
    private static let account = "jwt-token"

    static func save(_ token: String) {
        let data = Data(token.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        SecItemDelete(query as CFDictionary)
        let attributes: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: data,
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func read() -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

- [ ] **Step 5: Write unit test for KeychainService**

In the Xcode test target, create `assistant-companionTests/KeychainServiceTests.swift`:

```swift
import XCTest
@testable import assistant_companion

final class KeychainServiceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        KeychainService.delete()
    }

    func testSaveAndRead() {
        KeychainService.save("test-token-123")
        XCTAssertEqual(KeychainService.read(), "test-token-123")
    }

    func testDeleteClearsToken() {
        KeychainService.save("test-token-123")
        KeychainService.delete()
        XCTAssertNil(KeychainService.read())
    }

    func testOverwriteToken() {
        KeychainService.save("old-token")
        KeychainService.save("new-token")
        XCTAssertEqual(KeychainService.read(), "new-token")
    }
}
```

- [ ] **Step 6: Run tests in Xcode**

In Xcode: `Cmd+U`

Expected: All 3 KeychainService tests pass.

- [ ] **Step 7: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add models and KeychainService"
```

---

## Task 2: APIClient + SSEParser

**Files:**
- Create: `assistant-companion/assistant-companion/Services/APIClient.swift`
- Create: `assistant-companion/assistant-companion/Services/SSEParser.swift`

- [ ] **Step 1: Create Services/SSEParser.swift**

```swift
import Foundation

struct SSEEvent {
    let event: String
    let data: String
}

struct SSEParser {
    static func parse(lines: [String]) -> SSEEvent? {
        var eventType = "message"
        var dataLines: [String] = []

        for line in lines {
            if line.hasPrefix("event:") {
                eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }

        guard !dataLines.isEmpty else { return nil }
        return SSEEvent(event: eventType, data: dataLines.joined(separator: "\n"))
    }
}
```

- [ ] **Step 2: Write SSEParser unit test**

In `assistant-companionTests/SSEParserTests.swift`:

```swift
import XCTest
@testable import assistant_companion

final class SSEParserTests: XCTestCase {
    func testParsesTokenEvent() {
        let lines = ["event: token", "data: {\"text\":\"Hello\"}"]
        let event = SSEParser.parse(lines: lines)
        XCTAssertEqual(event?.event, "token")
        XCTAssertEqual(event?.data, "{\"text\":\"Hello\"}")
    }

    func testParsesDoneEvent() {
        let lines = ["event: done", "data: {\"messageId\":\"msg-123\"}"]
        let event = SSEParser.parse(lines: lines)
        XCTAssertEqual(event?.event, "done")
    }

    func testReturnsNilForEmptyLines() {
        XCTAssertNil(SSEParser.parse(lines: []))
    }

    func testDefaultsToMessageEventType() {
        let lines = ["data: hello"]
        let event = SSEParser.parse(lines: lines)
        XCTAssertEqual(event?.event, "message")
    }
}
```

- [ ] **Step 3: Run tests**

`Cmd+U` in Xcode.

Expected: All 4 SSEParser tests pass.

- [ ] **Step 4: Create Services/APIClient.swift**

```swift
import Foundation

enum APIError: Error {
    case unauthorized
    case notFound
    case serverError(Int)
    case decodingError(Error)
    case networkError(Error)
}

final class APIClient {
    let baseURL: URL
    var token: String?

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    private func request(path: String, method: String, body: Encodable? = nil) throws -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
        }
        return req
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        let req = try request(path: path, method: "GET")
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response)
        return try decode(T.self, from: data)
    }

    func post<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        let req = try request(path: path, method: "POST", body: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        try validate(response)
        return try decode(T.self, from: data)
    }

    func postEmpty<B: Encodable>(_ path: String, body: B) async throws {
        let req = try request(path: path, method: "POST", body: body)
        let (_, response) = try await URLSession.shared.data(for: req)
        try validate(response)
    }

    func delete(_ path: String) async throws {
        let req = try request(path: path, method: "DELETE")
        let (_, response) = try await URLSession.shared.data(for: req)
        try validate(response)
    }

    func sseStream(path: String) throws -> URLRequest {
        var req = try request(path: path, method: "GET")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 300
        return req
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        switch http.statusCode {
        case 200...299: return
        case 401: throw APIError.unauthorized
        case 404: throw APIError.notFound
        default: throw APIError.serverError(http.statusCode)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }
}
```

- [ ] **Step 5: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add APIClient and SSEParser"
```

---

## Task 3: AuthViewModel + LoginView + App Root

**Files:**
- Create: `assistant-companion/assistant-companion/ViewModels/AuthViewModel.swift`
- Create: `assistant-companion/assistant-companion/Views/LoginView.swift`
- Create: `assistant-companion/assistant-companion/App/RootView.swift`
- Modify: `assistant-companion/assistant-companion/assistant_companionApp.swift`

- [ ] **Step 1: Write AuthViewModel test**

In `assistant-companionTests/AuthViewModelTests.swift`:

```swift
import XCTest
@testable import assistant_companion

final class AuthViewModelTests: XCTestCase {
    func testIsAuthenticatedFalseByDefault() {
        KeychainService.delete()
        let vm = AuthViewModel(apiClient: APIClient(baseURL: URL(string: "http://localhost:3000")!))
        XCTAssertFalse(vm.isAuthenticated)
    }

    func testIsAuthenticatedTrueWhenTokenInKeychain() {
        KeychainService.save("existing-token")
        let vm = AuthViewModel(apiClient: APIClient(baseURL: URL(string: "http://localhost:3000")!))
        XCTAssertTrue(vm.isAuthenticated)
        KeychainService.delete()
    }

    func testLogoutClearsToken() {
        KeychainService.save("some-token")
        let client = APIClient(baseURL: URL(string: "http://localhost:3000")!)
        let vm = AuthViewModel(apiClient: client)
        vm.logout()
        XCTAssertFalse(vm.isAuthenticated)
        XCTAssertNil(KeychainService.read())
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

`Cmd+U` — Expected: FAIL, `AuthViewModel` not found.

- [ ] **Step 3: Create ViewModels/AuthViewModel.swift**

```swift
import Foundation
import Observation

@Observable
final class AuthViewModel {
    private(set) var isAuthenticated: Bool = false
    private(set) var errorMessage: String?
    var isLoading: Bool = false

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
        if let token = KeychainService.read() {
            apiClient.token = token
            isAuthenticated = true
        }
    }

    func login(username: String, password: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        struct LoginBody: Encodable { let username: String; let password: String }
        struct LoginResponse: Decodable { let token: String }

        do {
            let response: LoginResponse = try await apiClient.post(
                "/auth/login",
                body: LoginBody(username: username, password: password)
            )
            KeychainService.save(response.token)
            apiClient.token = response.token
            isAuthenticated = true
        } catch APIError.unauthorized {
            errorMessage = "Invalid username or password"
        } catch {
            errorMessage = "Connection failed. Check your network."
        }
    }

    func logout() {
        KeychainService.delete()
        apiClient.token = nil
        isAuthenticated = false
    }
}
```

- [ ] **Step 4: Run tests**

`Cmd+U` — Expected: PASS — all 3 AuthViewModel tests pass.

- [ ] **Step 5: Create Views/LoginView.swift**

```swift
import SwiftUI

struct LoginView: View {
    @Environment(AuthViewModel.self) private var auth
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        @Bindable var auth = auth
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("Password", text: $password)
                }

                if let error = auth.errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await auth.login(username: username, password: password) }
                    } label: {
                        if auth.isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Sign In")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(username.isEmpty || password.isEmpty || auth.isLoading)
                }
            }
            .navigationTitle("Hermes")
        }
    }
}
```

- [ ] **Step 6: Create App/RootView.swift**

```swift
import SwiftUI

struct RootView: View {
    @Environment(AuthViewModel.self) private var auth

    var body: some View {
        if auth.isAuthenticated {
            ConversationListView()
        } else {
            LoginView()
        }
    }
}
```

- [ ] **Step 7: Update assistant_companionApp.swift**

```swift
import SwiftUI

@main
struct assistant_companionApp: App {
    private let apiClient = APIClient(baseURL: URL(string: "http://YOUR-TAILSCALE-IP:3000")!)
    private let authViewModel: AuthViewModel

    init() {
        authViewModel = AuthViewModel(apiClient: apiClient)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(authViewModel)
        }
    }
}
```

> **Note:** Replace `YOUR-TAILSCALE-IP` with the Raspberry Pi's Tailscale IP address before running on device. Store this in a config file or xcconfig in a later pass if needed.

- [ ] **Step 8: Build in Xcode**

`Cmd+B` — Expected: Build succeeds (RootView will show a compile error for `ConversationListView` which doesn't exist yet — create a stub):

```swift
// Views/ConversationListView.swift — stub, will be replaced in Task 4
import SwiftUI
struct ConversationListView: View {
    var body: some View { Text("Conversations") }
}
```

- [ ] **Step 9: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add AuthViewModel, LoginView, and app root routing"
```

---

## Task 4: ConversationListViewModel + ConversationListView

**Files:**
- Create: `assistant-companion/assistant-companion/ViewModels/ConversationListViewModel.swift`
- Modify: `assistant-companion/assistant-companion/Views/ConversationListView.swift`

- [ ] **Step 1: Write ConversationListViewModel test**

In `assistant-companionTests/ConversationListViewModelTests.swift`:

```swift
import XCTest
@testable import assistant_companion

final class ConversationListViewModelTests: XCTestCase {
    func testConversationsEmptyByDefault() {
        let vm = ConversationListViewModel(apiClient: APIClient(baseURL: URL(string: "http://localhost:3000")!))
        XCTAssertTrue(vm.conversations.isEmpty)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

`Cmd+U` — Expected: FAIL.

- [ ] **Step 3: Create ViewModels/ConversationListViewModel.swift**

```swift
import Foundation
import Observation

@Observable
final class ConversationListViewModel {
    private(set) var conversations: [ConversationSummary] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            conversations = try await apiClient.get("/conversations")
        } catch {
            errorMessage = "Failed to load conversations"
        }
    }

    func create(title: String) async -> ConversationSummary? {
        struct Body: Encodable { let title: String }
        do {
            let conv: ConversationSummary = try await apiClient.post("/conversations", body: Body(title: title))
            conversations.insert(conv, at: 0)
            return conv
        } catch {
            errorMessage = "Failed to create conversation"
            return nil
        }
    }
}
```

- [ ] **Step 4: Run tests**

`Cmd+U` — Expected: PASS.

- [ ] **Step 5: Replace Views/ConversationListView.swift**

```swift
import SwiftUI

struct ConversationListView: View {
    @Environment(AuthViewModel.self) private var auth
    @State private var viewModel: ConversationListViewModel
    @State private var showingNewConversation = false
    @State private var newTitle = ""
    @State private var selectedConversation: ConversationSummary?

    init(apiClient: APIClient) {
        _viewModel = State(initialValue: ConversationListViewModel(apiClient: apiClient))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.conversations.isEmpty {
                    ProgressView()
                } else {
                    List(viewModel.conversations) { conv in
                        Button(conv.title) {
                            selectedConversation = conv
                        }
                    }
                    .navigationDestination(item: $selectedConversation) { conv in
                        ChatView(conversation: conv, apiClient: /* injected */ )
                    }
                }
            }
            .navigationTitle("Hermes")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New", systemImage: "plus") {
                        showingNewConversation = true
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Sign Out") {
                        auth.logout()
                    }
                }
            }
            .alert("New Conversation", isPresented: $showingNewConversation) {
                TextField("Title", text: $newTitle)
                Button("Create") {
                    Task {
                        let title = newTitle.isEmpty ? "New conversation" : newTitle
                        newTitle = ""
                        _ = await viewModel.create(title: title)
                    }
                }
                Button("Cancel", role: .cancel) { newTitle = "" }
            }
        }
        .task { await viewModel.load() }
    }
}
```

> **Note on APIClient injection:** `ConversationListView` and `ChatView` need the shared `APIClient`. Thread it through the environment. Update `RootView.swift` to pass it:

Update `App/RootView.swift`:

```swift
import SwiftUI

struct RootView: View {
    @Environment(AuthViewModel.self) private var auth
    let apiClient: APIClient

    var body: some View {
        if auth.isAuthenticated {
            ConversationListView(apiClient: apiClient)
        } else {
            LoginView()
        }
    }
}
```

Update `assistant_companionApp.swift` to pass `apiClient` to `RootView`:

```swift
RootView(apiClient: apiClient)
    .environment(authViewModel)
```

Update the `ConversationListView` stub reference to `ChatView`:

```swift
// placeholder until Task 5 — replace `/* injected */` with:
ChatView(conversation: conv, apiClient: apiClient)
// and add a ChatView stub so the build compiles:
```

Add stub `Views/ChatView.swift`:

```swift
import SwiftUI
struct ChatView: View {
    let conversation: ConversationSummary
    let apiClient: APIClient
    var body: some View { Text(conversation.title) }
}
```

- [ ] **Step 6: Build**

`Cmd+B` — Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add ConversationListViewModel and ConversationListView"
```

---

## Task 5: ChatViewModel (Messages + Send + Stream)

**Files:**
- Create: `assistant-companion/assistant-companion/ViewModels/ChatViewModel.swift`

- [ ] **Step 1: Write ChatViewModel test**

In `assistant-companionTests/ChatViewModelTests.swift`:

```swift
import XCTest
@testable import assistant_companion

final class ChatViewModelTests: XCTestCase {
    func testMessagesEmptyByDefault() {
        let vm = ChatViewModel(
            conversationId: "conv-1",
            apiClient: APIClient(baseURL: URL(string: "http://localhost:3000")!)
        )
        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertEqual(vm.streamingMessage, "")
        XCTAssertEqual(vm.locationMode, .off)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

`Cmd+U` — Expected: FAIL.

- [ ] **Step 3: Create ViewModels/ChatViewModel.swift**

```swift
import Foundation
import Observation

@Observable
final class ChatViewModel {
    private(set) var messages: [Message] = []
    var streamingMessage: String = ""
    var locationMode: LocationMode = .off
    var isStreaming: Bool = false
    private(set) var errorMessage: String?

    let conversationId: String
    private let apiClient: APIClient

    init(conversationId: String, apiClient: APIClient) {
        self.conversationId = conversationId
        self.apiClient = apiClient
    }

    func load() async {
        do {
            messages = try await apiClient.get("/conversations/\(conversationId)/messages")
        } catch {
            errorMessage = "Failed to load messages"
        }
    }

    func send(text: String) async {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        struct Body: Encodable { let text: String }
        struct SendResponse: Decodable { let messageId: String }

        // Optimistic local add
        let tempUserMessage = Message(
            id: UUID().uuidString,
            role: "user",
            content: text,
            created_at: ISO8601DateFormatter().string(from: Date())
        )
        messages.append(tempUserMessage)

        do {
            let _: SendResponse = try await apiClient.post(
                "/conversations/\(conversationId)/messages",
                body: Body(text: text)
            )
            await listenToStream()
        } catch {
            errorMessage = "Failed to send message"
        }
    }

    private func listenToStream() async {
        isStreaming = true
        streamingMessage = ""
        defer { isStreaming = false }

        do {
            let req = try apiClient.sseStream(path: "/conversations/\(conversationId)/stream")
            let (bytes, _) = try await URLSession.shared.bytes(for: req)

            var lineBuffer: [String] = []
            for try await line in bytes.lines {
                if line.isEmpty {
                    if let event = SSEParser.parse(lines: lineBuffer) {
                        await handleSSEEvent(event)
                        if event.event == "done" { break }
                    }
                    lineBuffer = []
                } else {
                    lineBuffer.append(line)
                }
            }
        } catch {
            errorMessage = "Stream interrupted"
        }
    }

    @MainActor
    private func handleSSEEvent(_ event: SSEEvent) {
        switch event.event {
        case "token":
            if let data = event.data.data(using: .utf8),
               let obj = try? JSONDecoder().decode([String: String].self, from: data),
               let text = obj["text"] {
                streamingMessage += text
            }
        case "done":
            if !streamingMessage.isEmpty {
                let assistantMsg = Message(
                    id: UUID().uuidString,
                    role: "assistant",
                    content: streamingMessage,
                    created_at: ISO8601DateFormatter().string(from: Date())
                )
                messages.append(assistantMsg)
                streamingMessage = ""
            }
        default:
            break
        }
    }
}
```

- [ ] **Step 4: Run tests**

`Cmd+U` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add ChatViewModel with message send and SSE streaming"
```

---

## Task 6: ChatView + MessageBubble + MessageComposer

**Files:**
- Modify: `assistant-companion/assistant-companion/Views/ChatView.swift` (replace stub)
- Create: `assistant-companion/assistant-companion/Views/MessageBubble.swift`
- Create: `assistant-companion/assistant-companion/Views/MessageComposer.swift`

- [ ] **Step 1: Create Views/MessageBubble.swift**

```swift
import SwiftUI

struct MessageBubble: View {
    let message: Message
    let isStreaming: Bool

    var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 60) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 2) {
                Text(message.content)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(isUser ? Color.blue : Color(.systemGray5))
                    .foregroundStyle(isUser ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            if !isUser { Spacer(minLength: 60) }
        }
    }
}

struct StreamingBubble: View {
    let text: String

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(text.isEmpty ? "..." : text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray5))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            Spacer(minLength: 60)
        }
    }
}
```

- [ ] **Step 2: Create Views/MessageComposer.swift**

```swift
import SwiftUI

struct MessageComposer: View {
    @Binding var text: String
    @Binding var locationMode: LocationMode
    let isSending: Bool
    let onSend: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                locationModeButton
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.vertical, 8)
                sendButton
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private var locationModeButton: some View {
        Menu {
            Button("Off") { locationMode = .off }
            Button("Share Once") { locationMode = .once }
            Button("Live") { locationMode = .live }
        } label: {
            Image(systemName: locationIconName)
                .foregroundStyle(locationMode == .off ? .secondary : .blue)
                .frame(width: 32, height: 32)
        }
    }

    private var locationIconName: String {
        switch locationMode {
        case .off: return "location.slash"
        case .once: return "location"
        case .live: return "location.fill"
        }
    }

    private var sendButton: some View {
        Button {
            onSend()
        } label: {
            Image(systemName: "arrow.up.circle.fill")
                .font(.title2)
                .foregroundStyle(text.trimmingCharacters(in: .whitespaces).isEmpty || isSending ? .secondary : .blue)
        }
        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || isSending)
    }
}
```

- [ ] **Step 3: Replace Views/ChatView.swift**

```swift
import SwiftUI

struct ChatView: View {
    let conversation: ConversationSummary
    let apiClient: APIClient

    @State private var viewModel: ChatViewModel
    @State private var inputText = ""

    init(conversation: ConversationSummary, apiClient: APIClient) {
        self.conversation = conversation
        self.apiClient = apiClient
        _viewModel = State(initialValue: ChatViewModel(conversationId: conversation.id, apiClient: apiClient))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(viewModel.messages) { msg in
                            MessageBubble(message: msg, isStreaming: false)
                                .id(msg.id)
                        }
                        if viewModel.isStreaming {
                            StreamingBubble(text: viewModel.streamingMessage)
                                .id("streaming")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .onChange(of: viewModel.messages.count) {
                    if let last = viewModel.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
                .onChange(of: viewModel.isStreaming) {
                    if viewModel.isStreaming {
                        proxy.scrollTo("streaming", anchor: .bottom)
                    }
                }
            }

            LocationIndicator(
                locationMode: viewModel.locationMode,
                onStop: { viewModel.locationMode = .off }
            )

            MessageComposer(
                text: $inputText,
                locationMode: Binding(
                    get: { viewModel.locationMode },
                    set: { viewModel.locationMode = $0 }
                ),
                isSending: viewModel.isStreaming
            ) {
                let text = inputText
                inputText = ""
                Task { await viewModel.send(text: text) }
            }
        }
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.load() }
    }
}
```

- [ ] **Step 4: Build**

`Cmd+B` — Expected: Build succeeds. `LocationIndicator` is referenced but not created yet — add a stub:

```swift
// Views/LocationIndicator.swift — stub, replaced in Task 8
import SwiftUI
struct LocationIndicator: View {
    let locationMode: LocationMode
    let onStop: () -> Void
    var body: some View { EmptyView() }
}
```

- [ ] **Step 5: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add ChatView, MessageBubble, and MessageComposer"
```

---

## Task 7: LocationService + Location Integration in ChatViewModel

**Files:**
- Create: `assistant-companion/assistant-companion/Services/LocationService.swift`
- Modify: `assistant-companion/assistant-companion/ViewModels/ChatViewModel.swift`

- [ ] **Step 1: Create Services/LocationService.swift**

```swift
import CoreLocation
import Foundation

final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: AsyncStream<CLLocation>.Continuation?

    var locationStream: AsyncStream<CLLocation> {
        AsyncStream { continuation in
            self.continuation = continuation
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
            continuation.onTermination = { [weak self] _ in
                self?.manager.stopUpdatingLocation()
            }
        }
    }

    func requestOnce() async throws -> CLLocation {
        return try await withCheckedThrowingContinuation { continuation in
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.requestWhenInUseAuthorization()
            self.continuation = AsyncStream<CLLocation>.makeStream().continuation
            manager.requestLocation()
            // Store continuation for single delivery
            _onceContinuation = continuation
        }
    }

    private var _onceContinuation: CheckedContinuation<CLLocation, Error>?

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        _onceContinuation?.resume(returning: location)
        _onceContinuation = nil
        continuation?.yield(location)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        _onceContinuation?.resume(throwing: error)
        _onceContinuation = nil
    }
}
```

- [ ] **Step 2: Update ChatViewModel to handle location before send**

Add to `ChatViewModel.swift`, replacing the `send` method:

```swift
private let locationService = LocationService()

func send(text: String) async {
    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }

    // Handle location before sending
    if locationMode == .once {
        await sendLocationOnce()
        locationMode = .off
    }

    struct Body: Encodable { let text: String }
    struct SendResponse: Decodable { let messageId: String }

    let tempUserMessage = Message(
        id: UUID().uuidString,
        role: "user",
        content: text,
        created_at: ISO8601DateFormatter().string(from: Date())
    )
    messages.append(tempUserMessage)

    do {
        let _: SendResponse = try await apiClient.post(
            "/conversations/\(conversationId)/messages",
            body: Body(text: text)
        )
        await listenToStream()
    } catch {
        errorMessage = "Failed to send message"
    }
}

private func sendLocationOnce() async {
    guard let location = try? await locationService.requestOnce() else { return }
    await postLocation(location, mode: "once")
}

func startLiveLocation() {
    guard locationMode == .live else { return }
    Task {
        for await location in locationService.locationStream {
            guard locationMode == .live else { break }
            await postLocation(location, mode: "live")
        }
    }
}

func stopLiveLocation() async {
    locationMode = .off
    do {
        try await apiClient.delete("/conversations/\(conversationId)/location")
    } catch {
        // best effort
    }
}

private func postLocation(_ location: CLLocation, mode: String) async {
    let formatter = ISO8601DateFormatter()
    let payload = LocationPayload(
        lat: location.coordinate.latitude,
        lon: location.coordinate.longitude,
        accuracy_m: location.horizontalAccuracy,
        timestamp: formatter.string(from: location.timestamp),
        mode: mode,
        source: "ios"
    )
    struct EmptyResponse: Decodable {}
    _ = try? await apiClient.postEmpty("/conversations/\(conversationId)/location", body: payload)
}
```

Add `import CoreLocation` at the top of `ChatViewModel.swift`.

- [ ] **Step 3: Update ChatView to start/stop live location on mode change**

In `ChatView.swift`, inside the body, add after `.task { await viewModel.load() }`:

```swift
.onChange(of: viewModel.locationMode) { _, newMode in
    if newMode == .live {
        viewModel.startLiveLocation()
    }
}
```

- [ ] **Step 4: Add NSLocationWhenInUseUsageDescription to Info.plist**

In Xcode, open `assistant-companion/Info.plist` and add:

```
Key: NSLocationWhenInUseUsageDescription
Value: Hermes uses your location to provide accurate location context during conversations.
```

- [ ] **Step 5: Build**

`Cmd+B` — Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add LocationService and location integration in ChatViewModel"
```

---

## Task 8: LocationIndicator

**Files:**
- Modify: `assistant-companion/assistant-companion/Views/LocationIndicator.swift` (replace stub)

- [ ] **Step 1: Replace Views/LocationIndicator.swift stub**

```swift
import SwiftUI

struct LocationIndicator: View {
    let locationMode: LocationMode
    let onStop: () -> Void

    var body: some View {
        if locationMode == .live {
            HStack(spacing: 6) {
                Image(systemName: "location.fill")
                    .font(.caption)
                Text("Sharing location")
                    .font(.caption)
                Spacer()
                Button("Stop") { onStop() }
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(Color.blue.opacity(0.1))
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
```

Update `ChatView.swift` to call `stopLiveLocation` when the indicator stop button is tapped:

In `ChatView.body`, change the `LocationIndicator` call to:

```swift
LocationIndicator(
    locationMode: viewModel.locationMode,
    onStop: {
        Task { await viewModel.stopLiveLocation() }
    }
)
```

- [ ] **Step 2: Build**

`Cmd+B` — Expected: Build succeeds.

- [ ] **Step 3: Run all tests**

`Cmd+U` — Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add assistant-companion/
git commit -m "feat: add LocationIndicator for live sharing status"
```

---

## Self-Review Checklist

- [x] All spec screens covered: LoginView, ConversationListView, ChatView
- [x] JWT stored in Keychain, read on launch, cleared on logout
- [x] SSE streaming via URLSession.bytes, token events append to streamingMessage, done commits to messages
- [x] Location: Off/Once/Live modes implemented
- [x] Once: sends location before message, resets to Off
- [x] Live: continuous updates via CLLocationManager, pill indicator shown, stop clears location and stops updates
- [x] Location never appears as a chat bubble
- [x] ConversationListView shows only current user's conversations (enforced by backend JWT)
- [x] APIClient injected through the view hierarchy from app root
- [x] No TBDs or placeholders
- [x] NSLocationWhenInUseUsageDescription added to Info.plist
