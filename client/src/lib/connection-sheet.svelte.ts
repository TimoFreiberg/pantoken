// Shared connection sheet state. Tracks which host id is currently shown in
// the focused ConnectionSheet (or null when hidden). The show/hide decision
// is driven by the ConnectionSheet component reacting to coordinator state.

class ConnectionState {
  /** The host id currently shown in the focused sheet, or null. */
  visibleHostId = $state<string | null>(null);

  /**
   * A host that entered an actionable state while the computer setup sheet
   * was open. The ConnectionSheet is deferred until setup closes, then this
   * host is surfaced if it's still actionable.
   */
  pendingHostId = $state<string | null>(null);

  show(id: string): void {
    this.visibleHostId = id;
  }

  hide(): void {
    this.visibleHostId = null;
  }

  /** Record a host that should be surfaced after setup closes. */
  setPending(id: string): void {
    this.pendingHostId = id;
  }

  /** Clear the pending host (e.g. after surfacing or when it's no longer actionable). */
  clearPending(): void {
    this.pendingHostId = null;
  }
}

export const connectionSheet = new ConnectionState();
