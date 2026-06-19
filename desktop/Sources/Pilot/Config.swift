import Foundation

/// Resolved launch configuration. The app itself is nearly stateless — the real pilot
/// code (server + client + watcher) lives in `clone`, a dedicated checkout that tracks
/// origin/main and auto-updates. The app just supervises processes against it.
struct Config {
    /// Dedicated checkout the app runs from (NOT your dev tree). Override: PILOT_APP_CLONE.
    let clone: URL
    /// Server state (VAPID key, archive index, pilot.pid). macOS Application Support so
    /// it's distinct from a dev `bun run dev`'s XDG dir → pidlocks never collide.
    let dataDir: URL
    /// Absolute path to `bun` — a Finder-launched app has a minimal PATH that omits it.
    let bunPath: String
    /// Free loopback port chosen at launch; passed to the server and the watcher.
    let serverPort: Int
    /// PATH handed to spawned processes so the server (pi → git/rg/shell) and the watcher
    /// (git/bun) resolve their tools. Mirrors the deploy plists' PATH.
    let augmentedPATH: String

    static func resolve(serverPort: Int) -> Config {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let env = ProcessInfo.processInfo.environment

        let clonePath =
            env["PILOT_APP_CLONE"] ?? home.appendingPathComponent("pilot-app").path

        let pathDirs = [
            home.appendingPathComponent(".bun/bin").path,
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
        ]

        return Config(
            clone: URL(fileURLWithPath: clonePath),
            dataDir: home.appendingPathComponent("Library/Application Support/Pilot"),
            bunPath: findBun(in: pathDirs) ?? "bun",
            serverPort: serverPort,
            augmentedPATH: pathDirs.joined(separator: ":")
        )
    }

    /// Environment for a spawned bun process: inherit the app's, then force a usable PATH
    /// and pin the server's host/port/data dir. No PILOT_TOKEN — loopback + single-user
    /// means auth off (the WS auto-authenticates), and nothing is exposed off-device.
    func serverEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = augmentedPATH
        env["PILOT_HOST"] = "127.0.0.1"
        env["PILOT_PORT"] = String(serverPort)
        env["PILOT_DATA_DIR"] = dataDir.path
        return env
    }

    /// Environment for the update-watcher: point it at this clone, this server's port, and
    /// the same data dir (so it finds pilot.pid for the restart signal).
    func watcherEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = augmentedPATH
        env["PILOT_APP_CLONE"] = clone.path
        // Pin the PORT, not individual URLs. The watcher derives BOTH /health and
        // /update/state from this. Pinning only PILOT_HEALTH_URL (the old bug) left
        // /update/state defaulting to :8787, so the watcher's card-state POSTs silently
        // missed the app's auto-assigned server — the update card never showed even as the
        // (health-derived) notification fired. One source of truth → no half-pinned config.
        env["PILOT_PORT"] = String(serverPort)
        env["PILOT_DATA_DIR"] = dataDir.path
        // The app owns notifications now (AppDelegate posts via UNUserNotificationCenter on
        // the watcher's `update-deferred` stdout event). Disable the watcher's own osascript
        // fallback — those notifications are attributed to Script Editor, so clicking one
        // opens Script Editor instead of Pilot.
        env["PILOT_UPDATE_NATIVE_NOTIFY"] = "0"
        return env
    }

    private static func findBun(in dirs: [String]) -> String? {
        let fm = FileManager.default
        for dir in dirs where fm.isExecutableFile(atPath: "\(dir)/bun") {
            return "\(dir)/bun"
        }
        return nil
    }
}
