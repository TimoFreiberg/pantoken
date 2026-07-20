//! Dock icon bounce on agent attention events (turn done, waiting, failed).
//!
//! The web client's Web Notifications path is broken in Tauri's WKWebView on
//! macOS — `new Notification()` silently fails. This command gives the client
//! a narrow IPC channel to request a macOS dock bounce instead. Follows the
//! same capability-grant pattern as window-drag.json.

use tauri::AppHandle;

/// Bounce the macOS dock icon until the user activates the app.
///
/// Called from the web client's attention-diff effect (App.svelte) when a
/// session transitions to `done`, `waiting`, or `failed` and the window is
/// unfocused. No-op on non-macOS and when the app is already active (Apple's
/// docs say to call `requestUserAttention` only when not already active).
#[tauri::command]
pub fn request_dock_attention(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplication, NSRequestUserAttentionType};
        use objc2_foundation::MainThreadMarker;

        // requestUserAttention must run on the main thread. Tauri commands
        // run on the main thread by default (the webview's JS thread), but
        // obtain the marker defensively.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        // Skip if the app is already active — bouncing when the user is
        // looking at it would be annoying, and Apple's docs say not to.
        if app.isActive() {
            return;
        }
        app.requestUserAttention(NSRequestUserAttentionType::CriticalRequest);
    }
    // Non-macOS: no-op (future: Windows taskbar flash, Linux urgency hint)
}
