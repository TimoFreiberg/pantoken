import AppKit

// Plain AppKit bootstrap — no storyboard, no SwiftUI — so the shell stays a handful of
// files. Everything interesting lives in AppDelegate: it supervises the local pilot
// server + the update-watcher and hosts the web client in a chromeless window.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
