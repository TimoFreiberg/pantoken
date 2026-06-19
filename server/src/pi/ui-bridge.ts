// Implements pi's ExtensionUIContext so the agent's interaction calls become
// pilot hostUiRequest events. Blocking dialogs (confirm/select/input/editor) return
// a Promise the agent awaits; pilot resolves it when a client answers (or on
// timeout/abort with a safe default). Fire-and-forget calls (notify/status/widget/
// title) just emit. TUI-only calls (header/footer/custom/working indicator) no-op,
// since there's no terminal on the other end.

import type {
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  HostUiRequest,
  HostUiResponse,
  QnaAnswer,
  QnaQuestion,
  SessionDriverEvent,
  SessionRef,
} from "@pilot/protocol";
import { createUnsupportedHostUiError } from "./unsupported-host-ui.js";

type Settle = (r: HostUiResponse | null) => void; // null = timeout/abort -> safe default

// Implements the parts of pi's ExtensionUIContext that make sense for a remote
// (dialogs + ambient UI). The remaining TUI-only members are stubbed so an extension
// calling them no-ops instead of crashing. Bound via an `as unknown as` cast at the
// call site — the `theme` getter can't return a real Theme without deep-importing pi
// internals, which the research flagged as version-fragile.
export class PiUiBridge {
  private pending = new Map<string, Settle>();
  private pendingRequestMap = new Map<string, HostUiRequest>();
  private seq = 0;

  // Current ambient UI state, retained so it can be replayed when this session is
  // (re)seeded on a focus switch. pi can't replay these (DECISIONS.md D5), so the
  // bridge that owns them does — otherwise switching away and back loses the
  // status strip / widgets / title until the extension happens to re-emit.
  private statuses = new Map<string, string>();
  private widgets = new Map<
    string,
    { lines: readonly string[]; placement: "aboveComposer" | "belowComposer" }
  >();
  private title: string | undefined;

  constructor(
    private ref: SessionRef,
    private emit: (ev: SessionDriverEvent) => void,
    private now: () => string = () => String(Date.now()),
  ) {}

  private id(): string {
    return `ui-${this.now()}-${this.seq++}`;
  }

  private hostUiEvent(request: HostUiRequest): SessionDriverEvent {
    return {
      sessionRef: this.ref,
      timestamp: this.now(),
      type: "hostUiRequest",
      request,
    };
  }

  private request(request: HostUiRequest): void {
    // Blocking requests are replayed when a warm session is refocused. Without this,
    // switching chats while an extension awaits an answer strands the hidden dialog.
    if (this.pending.has(request.requestId))
      this.pendingRequestMap.set(request.requestId, request);
    this.emit(this.hostUiEvent(request));
  }

  private arm(id: string, opts?: ExtensionUIDialogOptions): void {
    if (opts?.timeout) {
      const t = setTimeout(() => this.settle(id, null), opts.timeout);
      // don't keep the process alive on a dangling dialog timer
      (t as { unref?: () => void }).unref?.();
    }
    opts?.signal?.addEventListener("abort", () => this.settle(id, null), {
      once: true,
    });
  }

  /** Called by the driver when a client answers (or to force-settle). */
  resolve(response: HostUiResponse): void {
    this.settle(response.requestId, response);
  }

  /** Blocking requests still awaiting an operator, in arrival order. */
  pendingRequests(): readonly HostUiRequest[] {
    return [...this.pendingRequestMap.values()];
  }

  private settle(id: string, r: HostUiResponse | null): void {
    const fn = this.pending.get(id);
    if (!fn) return;
    this.pending.delete(id);
    this.pendingRequestMap.delete(id);
    fn(r);
    this.emit({
      sessionRef: this.ref,
      timestamp: this.now(),
      type: "hostUiResolved",
      requestId: id,
    });
  }

  // --- blocking dialogs ---

  confirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    const requestId = this.id();
    return new Promise<boolean>((resolve) => {
      this.pending.set(requestId, (r) =>
        resolve(!!r && "confirmed" in r && r.confirmed),
      );
      this.request({
        kind: "confirm",
        requestId,
        title,
        message,
        timeoutMs: opts?.timeout,
      });
      this.arm(requestId, opts);
    });
  }

  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    const requestId = this.id();
    return new Promise<string | undefined>((resolve) => {
      this.pending.set(requestId, (r) =>
        resolve(r && "value" in r ? r.value : undefined),
      );
      this.request({
        kind: "select",
        requestId,
        title,
        options,
        timeoutMs: opts?.timeout,
      });
      this.arm(requestId, opts);
    });
  }

  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    const requestId = this.id();
    return new Promise<string | undefined>((resolve) => {
      this.pending.set(requestId, (r) =>
        resolve(r && "value" in r ? r.value : undefined),
      );
      this.request({
        kind: "input",
        requestId,
        title,
        placeholder,
        timeoutMs: opts?.timeout,
      });
      this.arm(requestId, opts);
    });
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    const requestId = this.id();
    return new Promise<string | undefined>((resolve) => {
      this.pending.set(requestId, (r) =>
        resolve(r && "value" in r ? r.value : undefined),
      );
      this.request({ kind: "editor", requestId, title, initialValue: prefill });
    });
  }

  // Purpose-built multi-question form. NOT part of pi's ExtensionUIContext —
  // it's an extra capability pilot offers so an extension that wants a rich Q&A
  // can render one remotely (the answer extension feature-detects this method
  // and falls back to ui.custom only in a real terminal). Reachable because pi
  // hands extensions the raw bridge as `ctx.ui` (runner returns uiContext as-is,
  // unwrapped), so methods beyond the typed interface are still callable.
  // Resolves to the per-question answers, or null on cancel/timeout/abort.
  qna(
    questions: readonly QnaQuestion[],
    opts?: ExtensionUIDialogOptions & { title?: string },
  ): Promise<QnaAnswer[] | null> {
    const requestId = this.id();
    return new Promise<QnaAnswer[] | null>((resolve) => {
      this.pending.set(requestId, (r) =>
        resolve(r && "answers" in r ? (r.answers as QnaAnswer[]) : null),
      );
      this.request({
        kind: "qna",
        requestId,
        title: opts?.title,
        questions,
        timeoutMs: opts?.timeout,
      });
      this.arm(requestId, opts);
    });
  }

  // --- fire-and-forget ambient UI ---

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.request({
      kind: "notify",
      requestId: this.id(),
      message,
      level: type,
    });
  }

  setStatus(key: string, text: string | undefined): void {
    if (text) this.statuses.set(key, text);
    else this.statuses.delete(key);
    this.request({ kind: "status", requestId: this.id(), key, text });
  }

  setWidget(
    key: string,
    content: unknown,
    options?: ExtensionWidgetOptions,
  ): void {
    // Only the string[] form is renderable remotely; the TUI component factory is ignored.
    if (content === undefined || Array.isArray(content)) {
      const placement =
        options?.placement === "belowEditor"
          ? "belowComposer"
          : "aboveComposer";
      const lines = content as string[] | undefined;
      // Retain non-empty widgets for replay; an empty/cleared widget drops the entry.
      if (lines && lines.length > 0)
        this.widgets.set(key, { lines: [...lines], placement });
      else this.widgets.delete(key);
      this.request({
        kind: "widget",
        requestId: this.id(),
        key,
        lines,
        placement,
      });
    }
  }

  setTitle(title: string): void {
    this.title = title;
    this.request({ kind: "title", requestId: this.id(), title });
  }

  setEditorText(text: string): void {
    this.request({ kind: "editorText", requestId: this.id(), text });
  }

  /**
   * Reconstruct the current ambient UI (status strip, widgets, title) as
   * hostUiRequest events, so a session being (re)seeded on focus switch restores
   * them. `editorText` is intentionally excluded — it's per-client composer prefill,
   * not shared session state. `notify` is a one-shot toast, not retained.
   */
  ambientSeedEvents(): SessionDriverEvent[] {
    const events: SessionDriverEvent[] = [];
    for (const [key, text] of this.statuses)
      events.push(
        this.hostUiEvent({ kind: "status", requestId: this.id(), key, text }),
      );
    for (const [key, { lines, placement }] of this.widgets)
      events.push(
        this.hostUiEvent({
          kind: "widget",
          requestId: this.id(),
          key,
          lines: [...lines],
          placement,
        }),
      );
    if (this.title !== undefined)
      events.push(
        this.hostUiEvent({
          kind: "title",
          requestId: this.id(),
          title: this.title,
        }),
      );
    return events;
  }

  // --- TUI-only: no terminal on the other end, so these no-op ---

  onTerminalInput(): () => void {
    return () => {};
  }
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setFooter(): void {}
  setHeader(): void {}
  pasteToEditor(): void {}
  getEditorText(): string {
    return "";
  }
  // Throws a typed unsupported-host error (not a plain Error) so pi's runner
  // tags it with extensionPath/event and the driver's onError can surface it as
  // an extensionCompatibilityIssue. An extension that awaits this can still
  // catch and degrade; an unhandled one becomes a transcript notice.
  custom<T>(): Promise<T> {
    return Promise.reject(createUnsupportedHostUiError("custom"));
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(): undefined {
    return undefined;
  }
  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: "themes not supported in pilot remote" };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
  get theme(): undefined {
    return undefined;
  }
}
