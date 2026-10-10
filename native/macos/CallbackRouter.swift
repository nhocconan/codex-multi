import AppKit
import CoreServices
import Foundation

// This helper owns only callback routing. URLs stay in memory and are delivered
// directly to a selected running process; they never become command arguments.
private let codexScheme = "codex" as CFString

private func legacyHandler() -> String? {
    LSCopyDefaultHandlerForURLScheme(codexScheme)?.takeRetainedValue() as String?
}

private func currentHandler() -> String? {
    // Match the effective resolution used when macOS opens a URL (and by
    // Electron's default-protocol check), rather than only legacy LS metadata.
    if let url = URL(string: "codex://connector/"),
       let applicationURL = NSWorkspace.shared.urlForApplication(toOpen: url),
       let identifier = Bundle(url: applicationURL)?.bundleIdentifier {
        return identifier
    }
    return legacyHandler()
}

private func registrationConfirmed(_ bundleID: String, actualHandler: String?, completed: Bool, failed: Bool) -> Bool {
    completed && !failed && actualHandler == bundleID
}

// Background maintenance must remain quiet: never request system consent from
// the watcher. A successful LaunchServices status does not prove registration.
private func reassertHandler(_ bundleID: String) {
    LSSetDefaultHandlerForURLScheme(codexScheme, bundleID as CFString)
}

private func registrationDiagnostic(_ reason: String, error: NSError? = nil, actualHandler: String? = nil, legacyHandlerID: String? = nil) {
    var message = "Codex callback registration failed: " + reason
    if let error {
        // Framework error metadata only. Never print userInfo, localized error
        // descriptions, URLs, or arbitrary strings that could contain secrets.
        let domain = error.domain.utf8.count <= 128 &&
            error.domain.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
            ? error.domain : "unknown"
        message += " domain=" + domain + " code=" + String(error.code)
    }
    if let actualHandler, validBundleID(actualHandler) {
        message += " actual-handler=" + actualHandler
    }
    if let legacyHandlerID, validBundleID(legacyHandlerID) {
        message += " legacy-handler=" + legacyHandlerID
    }
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func registerHandler(_ bundleID: String) -> Bool {
    if currentHandler() == bundleID { return true }
    if #available(macOS 12.0, *) {
        let applicationURL: URL?
        if Bundle.main.bundleIdentifier == bundleID {
            applicationURL = Bundle.main.bundleURL
        } else {
            applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
        }
        guard let applicationURL else {
            registrationDiagnostic("bundle-lookup-unavailable")
            return false
        }
        var completed = false
        var failed = false
        var completionError: NSError?
        NSWorkspace.shared.setDefaultApplication(at: applicationURL, toOpenURLsWithScheme: "codex") { error in
            // The run loop below keeps the command responsive to asynchronous
            // system consent; state updates are serialized on the main thread.
            DispatchQueue.main.async {
                failed = error != nil
                completionError = error as NSError?
                completed = true
            }
        }
        let deadline = Date().addingTimeInterval(30)
        while !completed && Date() < deadline {
            RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.05)))
        }
        // Do not bypass a rejected or expired consent request with the legacy
        // API, and never report success while the system still uses another app.
        var actualHandler = currentHandler()
        if completed && !failed && actualHandler != bundleID {
            // LaunchServices may publish URL resolution after the successful
            // consent completion. Poll only; never repeat the setter or bypass
            // an error/denial while waiting for the effective handler to change.
            let propagationDeadline = Date().addingTimeInterval(3)
            while actualHandler != bundleID && Date() < propagationDeadline {
                RunLoop.current.run(until: min(propagationDeadline, Date().addingTimeInterval(0.05)))
                actualHandler = currentHandler()
            }
        }
        let confirmed = registrationConfirmed(bundleID, actualHandler: actualHandler, completed: completed, failed: failed)
        if !confirmed {
            if !completed {
                registrationDiagnostic("completion-timeout")
            } else if let completionError {
                registrationDiagnostic("system-error", error: completionError)
            } else {
                registrationDiagnostic("handler-unchanged", actualHandler: actualHandler, legacyHandlerID: legacyHandler())
            }
        }
        return confirmed
    }
    let status = LSSetDefaultHandlerForURLScheme(codexScheme, bundleID as CFString)
    let actualHandler = currentHandler()
    let confirmed = registrationConfirmed(bundleID, actualHandler: actualHandler, completed: true, failed: status != noErr)
    if !confirmed {
        if status != noErr {
            registrationDiagnostic("legacy-system-error", error: NSError(domain: NSOSStatusErrorDomain, code: Int(status)))
        } else {
            registrationDiagnostic("handler-unchanged", actualHandler: actualHandler, legacyHandlerID: legacyHandler())
        }
    }
    return confirmed
}

private func validBundleID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 255 && value.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]*$", options: .regularExpression) != nil
}

private func validCallback(_ raw: String) -> Bool {
    guard !raw.isEmpty, raw.utf8.count <= 65_536,
          !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let decoded = raw.removingPercentEncoding,
          !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let components = URLComponents(string: raw),
          components.scheme?.lowercased() == "codex",
          let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil,
          components.url != nil else { return false }
    return true
}

private func canQueueCallback(_ raw: String, pendingCount: Int) -> Bool {
    pendingCount < 16 && validCallback(raw)
}

private func matchesDataDirectory(_ arguments: String, directory: String) -> Bool {
    let flag = " --user-data-dir=" + directory
    guard let match = arguments.range(of: flag) else { return false }
    let tail = arguments[match.upperBound...]
    return tail.isEmpty || tail.hasPrefix(" --")
}

// Exercise the production validators without reading profiles or changing the
// system URL handler. Only the assertion count is printed, never sample URLs.
private func selfTest() {
    var count = 0
    let accepted = [
        "codex://connector/oauth_callback?code=fake-code&state=fake-state",
        "codex://another-host/path",
        "CODEX://connector/oauth_callback",
        "codex://connector/oauth_callback?code=a%2Bb",
    ]
    let rejected = [
        "", "https://connector/oauth_callback", "codex:///oauth_callback",
        "codex://user:password@connector/oauth_callback",
        "codex://user@connector/oauth_callback",
        "codex://connector/oauth_callback\n",
        "codex://connector/oauth_callback?code=%0A",
        "codex://connector/oauth_callback?code=%7F",
        "codex://connector/oauth_callback?code=%",
        "codex://connector/" + String(repeating: "x", count: 65_536),
    ]
    for value in accepted {
        precondition(validCallback(value), "Native callback validation failed")
        count += 1
    }
    for value in rejected {
        precondition(!validCallback(value), "Native callback validation failed")
        count += 1
    }
    let directory = "/Users/fixture/Root With Spaces/desktop/work"
    let command = "/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=" + directory
    let pathCases: [(String, Bool)] = [
        (command, true), (command + " --other-option", true),
        (command + "-other", false), (command + " other", false),
        (command + "/nested", false),
        ("/Applications/Codex.app/Contents/MacOS/Codex", false),
    ]
    for (value, expected) in pathCases {
        precondition(matchesDataDirectory(value, directory: directory) == expected, "Native profile matching failed")
        count += 1
    }
    let registrationCases: [(String?, Bool, Bool, Bool)] = [
        ("com.fixture.router", true, false, true),
        ("com.openai.codex", true, false, false),
        (nil, true, false, false),
        ("com.fixture.router", false, false, false),
        ("com.fixture.router", true, true, false),
    ]
    for (handler, completed, failed, expected) in registrationCases {
        precondition(registrationConfirmed("com.fixture.router", actualHandler: handler, completed: completed, failed: failed) == expected,
            "Native handler verification failed")
        count += 1
    }
    let queueCases: [(String, Int, Bool)] = [
        (accepted[0], 0, true), (accepted[0], 15, true),
        (accepted[0], 16, false), (accepted[0], 17, false),
        (rejected[1], 0, false),
    ]
    for (value, pendingCount, expected) in queueCases {
        precondition(canQueueCallback(value, pendingCount: pendingCount) == expected,
            "Native callback queue validation failed")
        count += 1
    }
    print("\(count) native router assertions passed")
}

private struct Profile {
    let slug: String
    let label: String
}

private struct Destination {
    let pid: pid_t
    let title: String
    let bundleURL: URL
    let dataDirectory: String?
}

private final class Router: NSObject, NSApplicationDelegate {
    private var pending: [String] = []
    private var choosing = false
    private weak var continueButton: NSButton?
    private let root: URL?
    private let registry: URL?
    private let officialBundleID: String

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        if let path = info["CodexMultiRoot"] as? String, path.hasPrefix("/") {
            root = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        } else {
            root = nil
        }
        if let path = info["CodexMultiProfilesFile"] as? String, path.hasPrefix("/") {
            registry = URL(fileURLWithPath: path)
        } else {
            registry = root?.appendingPathComponent("profiles.json")
        }
        officialBundleID = info["CodexMultiAppBundleIdentifier"] as? String ?? "com.openai.codex"
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(receiveURL(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        processNext()
    }

    @objc private func receiveURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              canQueueCallback(raw, pendingCount: pending.count) else {
            reply.setParam(NSAppleEventDescriptor(int32: Int32(paramErr)), forKeyword: AEKeyword(keyErrorNumber))
            return
        }
        pending.append(raw)
        DispatchQueue.main.async { [weak self] in self?.processNext() }
    }

    private func profiles() -> [Profile] {
        guard let registry,
              let data = try? Data(contentsOf: registry),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        var seen = Set<String>()
        return rows.compactMap { row in
            guard let slug = row["slug"] as? String,
                  slug != "multi",
                  slug.range(of: "^[a-z0-9]+(?:-[a-z0-9]+)*$", options: .regularExpression) != nil,
                  seen.insert(slug).inserted,
                  let label = row["label"] as? String, !label.isEmpty,
                  !label.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
            return Profile(slug: slug, label: label)
        }
    }

    // ps is used only to inspect the running app's startup arguments. Callback
    // URLs are never passed to this or any other child process.
    private func arguments(for pid: pid_t) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-ww", "-p", String(pid), "-o", "args="]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .newlines)
        } catch { return nil }
    }

    private func isMainApp(_ app: NSRunningApplication, arguments: String) -> Bool {
        guard !app.isTerminated, app.bundleIdentifier == officialBundleID,
              let bundleURL = app.bundleURL,
              let bundle = Bundle(url: bundleURL),
              bundle.object(forInfoDictionaryKey: "CodexMultiSlug") == nil,
              arguments.contains(".app/Contents/MacOS/"),
              arguments.range(of: "(?:^|\\s)--type(?:=|\\s)", options: .regularExpression) == nil else { return false }
        return true
    }

    fileprivate func destinations() -> [Destination] {
        guard let root else { return [] }
        let profiles = profiles()
        let desktop = root.appendingPathComponent("desktop", isDirectory: true)
        var result: [Destination] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let args = arguments(for: app.processIdentifier), isMainApp(app, arguments: args),
                  let bundleURL = app.bundleURL else { continue }
            if let profile = profiles.first(where: {
                matchesDataDirectory(args, directory: desktop.appendingPathComponent($0.slug, isDirectory: true).path)
            }) {
                result.append(Destination(pid: app.processIdentifier,
                    title: "\(profile.label) (\(profile.slug)) — PID \(app.processIdentifier)",
                    bundleURL: bundleURL,
                    dataDirectory: desktop.appendingPathComponent(profile.slug, isDirectory: true).path))
            } else if !args.contains(" --user-data-dir=" + desktop.path + "/") {
                result.append(Destination(pid: app.processIdentifier,
                    title: "Original Codex app — PID \(app.processIdentifier)",
                    bundleURL: bundleURL, dataDirectory: nil))
            }
        }
        return result.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    @objc private func selectionChanged(_ popup: NSPopUpButton) {
        continueButton?.isEnabled = popup.indexOfSelectedItem > 0
    }

    private func genericError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Codex callback router"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    private func processNext() {
        guard !choosing, !pending.isEmpty else { return }
        choosing = true
        var callback: String? = pending.removeFirst()
        defer {
            // Cancel, failed delivery, and success all release the selected
            // callback. Queued callbacks remain memory-only until processed;
            // after the bounded queue drains this helper terminates itself.
            callback = nil
            continueButton = nil
            choosing = false
            if !pending.isEmpty {
                DispatchQueue.main.async { [weak self] in self?.processNext() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    guard let self, !self.choosing, self.pending.isEmpty else { return }
                    NSApp.terminate(nil)
                }
            }
        }
        let choices = destinations()
        guard !choices.isEmpty else {
            genericError("No running Codex app was found. Open the intended profile and retry the connection.")
            return
        }
        let alert = NSAlert()
        alert.messageText = "Choose the Codex profile for this callback"
        alert.informativeText = "Select the running app where you started the connection. The callback will be sent only to that app."
        let button = alert.addButton(withTitle: "Continue")
        button.isEnabled = false
        continueButton = button
        alert.addButton(withTitle: "Cancel")
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 420, height: 28), pullsDown: false)
        popup.addItem(withTitle: "Select a running profile…")
        choices.forEach { popup.addItem(withTitle: $0.title) }
        popup.selectItem(at: 0)
        popup.target = self
        popup.action = #selector(selectionChanged(_:))
        alert.accessoryView = popup
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn,
              popup.indexOfSelectedItem > 0,
              popup.indexOfSelectedItem <= choices.count,
              let raw = callback else { return }
        let selected = choices[popup.indexOfSelectedItem - 1]
        guard let app = NSRunningApplication(processIdentifier: selected.pid),
              app.bundleURL == selected.bundleURL,
              let args = arguments(for: selected.pid), isMainApp(app, arguments: args),
              selected.dataDirectory.map({ matchesDataDirectory(args, directory: $0) }) ?? !args.contains(" --user-data-dir=" + (root?.appendingPathComponent("desktop").path ?? "") + "/") else {
            genericError("The selected app is no longer running. Open the intended profile and retry the connection.")
            return
        }
        var pid = selected.pid
        let target = withUnsafeBytes(of: &pid) {
            NSAppleEventDescriptor(descriptorType: DescType(typeKernelProcessID), data: Data($0))
        }
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kInternetEventClass),
            eventID: AEEventID(kAEGetURL), targetDescriptor: target,
            returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(NSAppleEventDescriptor(string: raw), forKeyword: AEKeyword(keyDirectObject))
        do {
            let reply = try event.sendEvent(options: [.waitForReply, .canInteract], timeout: 30)
            if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)), error.int32Value != 0 {
                genericError("The selected app could not accept the callback. Check macOS System Settings → Privacy & Security → Automation, allow this router to control Codex, and retry the connection in that app.")
            }
        } catch {
            genericError("The callback could not be delivered to the selected app. Check macOS System Settings → Privacy & Security → Automation, allow this router to control Codex, and retry the connection in that app.")
        }
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--self-test"] {
    selfTest()
    exit(0)
}
if args == ["--destinations"] {
    let rows = Router().destinations().map { ["pid": $0.pid, "title": $0.title] as [String: Any] }
    if let data = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
        print(json)
        exit(0)
    }
    exit(1)
}
if args == ["--handler"] {
    if let handler = currentHandler() { print(handler) }
    exit(0)
}
if args.count == 2, args[0] == "--register", validBundleID(args[1]) {
    // Consent registration is an explicit user action. Initialize AppKit and
    // announce the app before invoking NSWorkspace's asynchronous system UI.
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    exit(registerHandler(args[1]) ? 0 : 1)
}
if args.count == 2, args[0] == "--watch", validBundleID(args[1]) {
    let bundleID = args[1]
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: 3)
    timer.setEventHandler {
        if currentHandler() != bundleID { reassertHandler(bundleID) }
    }
    timer.resume()
    dispatchMain()
}
if !args.isEmpty, args.contains(where: { !$0.hasPrefix("-psn_") }) { exit(2) }
let app = NSApplication.shared
private let router = Router()
app.delegate = router
app.run()
