import Foundation

/// Owns the lifecycle of the local pilot server process. This is the "supervisor" the
/// update-watcher's restart contract depends on: the watcher SIGTERMs the server (via
/// pilot.pid) after staging an update, and we KeepAlive-respawn it from the now-updated
/// clone. The same path covers an unexpected crash.
///
/// Callbacks fire on the main queue:
///   • onHealthy(firstTime): server answered /health. firstTime → initial boot (load the
///     web client); otherwise it just came back from a restart (reload to pick up new
///     client assets after an update).
///   • onUnrecoverable(message): initial boot never got healthy, or it's crash-looping.
final class ServerSupervisor {
    private let config: Config
    var onHealthy: ((_ firstTime: Bool) -> Void)?
    var onUnrecoverable: ((_ message: String) -> Void)?

    private var process: Process?
    private var stopped = false
    private var started = false       // have we ever been healthy?
    private var spawnTime = Date()
    private var rapidRestarts = 0      // consecutive restarts after <5s uptime

    init(config: Config) {
        self.config = config
    }

    func start() {
        spawn()
    }

    /// SIGTERM the server and stop respawning (called on app quit). The server releases
    /// its pidlock and exits cleanly on SIGTERM.
    func stop() {
        stopped = true
        process?.terminationHandler = nil
        process?.terminate()
    }

    private func spawn() {
        spawnTime = Date()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.bunPath)
        p.arguments = ["run", "src/index.ts"]
        p.currentDirectoryURL = config.clone.appendingPathComponent("server")
        p.environment = config.serverEnv()
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.handleExit() }
        }
        do {
            try p.run()
            process = p
            waitForHealth()
        } catch {
            onUnrecoverable?("Couldn't launch the pilot server with bun at \(config.bunPath): \(error.localizedDescription)")
        }
    }

    private func handleExit() {
        guard !stopped else { return }
        // KeepAlive with a crash-loop guard: a quick exit (<5s uptime) counts toward the
        // strike limit; a restart after real uptime (e.g. a watcher update) resets it.
        let uptime = Date().timeIntervalSince(spawnTime)
        rapidRestarts = uptime < 5 ? rapidRestarts + 1 : 0
        if rapidRestarts > 5 {
            onUnrecoverable?("The pilot server keeps exiting right after launch. Check that the clone builds (bun install && bun run build in \(config.clone.path)).")
            return
        }
        let delay = min(Double(rapidRestarts), 3.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.spawn()
        }
    }

    /// Poll /health until 200 or timeout. On success, reset the crash-loop counter and
    /// fire onHealthy (firstTime iff we'd never been healthy before).
    private func waitForHealth(timeout: TimeInterval = 30) {
        let deadline = Date().addingTimeInterval(timeout)
        let url = URL(string: "http://127.0.0.1:\(config.serverPort)/health")!

        func poll() {
            var req = URLRequest(url: url)
            req.timeoutInterval = 2
            URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
                guard let self else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    DispatchQueue.main.async {
                        guard !self.stopped else { return }
                        self.rapidRestarts = 0
                        let firstTime = !self.started
                        self.started = true
                        self.onHealthy?(firstTime)
                    }
                } else if Date() < deadline {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.25, execute: poll)
                } else if !self.started {
                    DispatchQueue.main.async {
                        self.onUnrecoverable?("The pilot server didn't become healthy within \(Int(timeout))s.")
                    }
                }
                // A failed re-check after a restart isn't fatal — terminationHandler /
                // crash-loop guard will respawn it.
            }.resume()
        }
        poll()
    }
}
