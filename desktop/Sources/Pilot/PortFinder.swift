import Darwin
import Foundation

enum PortFinder {
    /// Ask the OS for a free loopback TCP port: bind a socket to 127.0.0.1:0, read back
    /// the port the kernel assigned, then close it. There's a tiny TOCTOU window before
    /// the server binds the same port; for a single-user local app that's acceptable —
    /// a lost race shows up as the server failing its health gate, which surfaces an
    /// error rather than corrupting anything.
    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0  // 0 = let the kernel choose

        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }

        var assigned = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &len)
            }
        }
        guard named == 0 else { return nil }

        return Int(UInt16(bigEndian: assigned.sin_port))
    }
}
