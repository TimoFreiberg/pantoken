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
  SessionDriverEvent,
  SessionRef,
} from "@pilot/protocol";

type Settle = (r: HostUiResponse | null) => void; // null = timeout/abort -> safe default

// Implements the parts of pi's ExtensionUIContext that make sense for a remote
// (dialogs + ambient UI). The remaining TUI-only members are stubbed so an extension
// calling them no-ops instead of crashing. Bound via an `as unknown as` cast at the
// call site — the `theme` getter can't return a real Theme without deep-importing pi
// internals, which the research flagged as version-fragile.
export class PiUiBridge {
  private pending = new Map<string, Settle>();
  private seq = 0;

  constructor(
    private ref: SessionRef,
    private emit: (ev: SessionDriverEvent) => void,
    private now: () => string = () => String(Date.now()),
  ) {}

  private id(): string {
    return `ui-${this.now()}-${this.seq++}`;
  }

  private request(request: HostUiRequest): void {
    this.emit({
      sessionRef: this.ref,
      timestamp: this.now(),
      type: "hostUiRequest",
      request,
    });
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

  /** Re-point at a newly-active session (after a switch): stamp emitted events with
   *  the new ref and drop dialogs from the previous, now-disposed session. */
  rebind(ref: SessionRef): void {
    this.ref = ref;
    this.pending.clear();
  }

  private settle(id: string, r: HostUiResponse | null): void {
    const fn = this.pending.get(id);
    if (!fn) return;
    this.pending.delete(id);
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
      this.request({
        kind: "widget",
        requestId: this.id(),
        key,
        lines: content as string[] | undefined,
        placement,
      });
    }
  }

  setTitle(title: string): void {
    this.request({ kind: "title", requestId: this.id(), title });
  }

  setEditorText(text: string): void {
    this.request({ kind: "editorText", requestId: this.id(), text });
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
  custom<T>(): Promise<T> {
    return Promise.reject(
      new Error("custom() UI is not supported by the pilot remote"),
    );
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
