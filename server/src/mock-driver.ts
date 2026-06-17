// Replays deterministic fixture scripts as a PilotDriver. Stands in for a real pi
// session so the whole UI pipeline can be built and screenshot-verified without a
// live model or API keys.

import type {
  HostUiResponse,
  ModelOption,
  SessionConfig,
  SessionDriverEvent,
  SessionListEntry,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import {
  ambient,
  confirmDialog,
  greeting,
  inputDialog,
  MOCK_DEFAULT_CONFIG,
  MOCK_MODELS,
  mockSessionSeed,
  NEW_SESSION_ENTRY,
  newSessionSeed,
  promptReply,
  type ScriptStep,
  SESSION_LIST,
  SESSION_REF,
  snapshot,
  trustDialog,
} from "./fixtures.js";

export class MockDriver implements PilotDriver {
  private listeners = new Set<(ev: SessionDriverEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pendingDialogs = new Set<string>();
  private sessions: SessionListEntry[] = SESSION_LIST.map((s) => ({ ...s }));
  // The mock's current model selection, mutated by setModel/setThinking so the picker
  // reflects a switch. (Scripted replies still emit the fixture default — fine for a
  // deterministic mock; the picker is exercised on its own.)
  private config: SessionConfig = { ...MOCK_DEFAULT_CONFIG };

  subscribe(listener: (ev: SessionDriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: SessionDriverEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[mock] listener error", e);
      }
    }
  }

  /** Schedule a script's steps with their cumulative delays. */
  private play(steps: ScriptStep[]): void {
    let t = 0;
    for (const step of steps) {
      t += step.wait;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.emit(step.event);
        if (
          step.event.type === "hostUiRequest" &&
          "timeoutMs" in step.event.request
        ) {
          // remember dialogs so respondUi / abort can settle them
          this.pendingDialogs.add(step.event.request.requestId);
        }
      }, t);
      this.timers.add(timer);
    }
  }

  /** Emit the initial conversation so a fresh server isn't blank. */
  bootstrap(): void {
    this.play(greeting());
  }

  /** Cancel everything in flight and replay the initial fixture (test determinism). */
  reset(): void {
    this.cancelTimers();
    this.sessions = SESSION_LIST.map((s) => ({ ...s }));
    this.config = { ...MOCK_DEFAULT_CONFIG };
    this.bootstrap();
  }

  prompt(text: string): void {
    this.play(promptReply(text));
  }

  abort(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "runCompleted",
      snapshot: {
        ref: SESSION_REF,
        workspace: {
          workspaceId: SESSION_REF.workspaceId,
          path: "/Users/timo/src/pilot",
        },
        title: "Wire up the WebSocket bridge",
        status: "idle",
        updatedAt: String(Date.now()),
      },
    });
  }

  respondUi(response: HostUiResponse): void {
    this.pendingDialogs.delete(response.requestId);
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiResolved",
      requestId: response.requestId,
    });
    const summary =
      "cancelled" in response
        ? "Dialog cancelled."
        : "confirmed" in response
          ? response.confirmed
            ? "Approved — continuing."
            : "Denied — skipping that step."
          : `Received: ${response.value}`;
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiRequest",
      request: {
        kind: "notify",
        requestId: `resolved-${response.requestId}`,
        message: summary,
        level: "info",
      },
    });
  }

  async listSessions(): Promise<SessionListEntry[]> {
    return this.sessions.map((s) => ({ ...s }));
  }

  async openSession(path: string): Promise<SessionDriverEvent[]> {
    this.cancelTimers(); // a switch ends any in-flight stream
    return mockSessionSeed(path);
  }

  async newSession(cwd?: string): Promise<SessionDriverEvent[]> {
    this.cancelTimers();
    // Honor a typed cwd so the new row groups under that project in the sidebar
    // (deterministic: one synthetic "new" entry per distinct cwd).
    const dir = cwd?.trim() || NEW_SESSION_ENTRY.cwd;
    const sessionId =
      dir === NEW_SESSION_ENTRY.cwd
        ? NEW_SESSION_ENTRY.sessionId
        : `new-${dir}`;
    if (!this.sessions.some((s) => s.sessionId === sessionId))
      this.sessions = [
        { ...NEW_SESSION_ENTRY, sessionId, cwd: dir },
        ...this.sessions,
      ];
    return newSessionSeed();
  }

  async listModels(): Promise<ModelOption[]> {
    return MOCK_MODELS.map((m) => ({ ...m }));
  }

  setModel(provider: string, modelId: string): void {
    this.config = { ...this.config, provider, modelId };
    this.emitConfig();
  }

  setThinking(level: string): void {
    this.config = { ...this.config, thinkingLevel: level };
    this.emitConfig();
  }

  /** Broadcast the current model selection as a sessionUpdated (idle) snapshot. */
  private emitConfig(): void {
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "sessionUpdated",
      snapshot: snapshot({ config: this.config }),
    });
  }

  private cancelTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingDialogs.clear();
  }

  runScript(name: string): void {
    const map: Record<string, () => ScriptStep[]> = {
      confirm: confirmDialog,
      trust: trustDialog,
      input: inputDialog,
      ambient,
      reply: () => promptReply("Show me the streamed reply script."),
    };
    const make = map[name];
    if (make) this.play(make());
  }
}
