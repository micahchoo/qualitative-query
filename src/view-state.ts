/** A run of a Question, alive until the view is invalidated, refreshed or unloaded. */
export interface RunToken { readonly current: () => boolean }

/**
 * What a Question view is doing, and what a change means while it does it.
 *
 * Three things happen to a view: a run (parse, retrieve, judge, render), a save (writing a
 * note — an inclusion, or the baked selection), and a change to the vault or the note. The
 * rules between them are the whole content of this module:
 *
 * - A change while running makes the run stale: abort it, refresh.
 * - A change while saving is deferred: the write must finish untouched, because it edits
 *   source notes and those edits fire the very events that would abort it. The view
 *   refreshes when the save ends.
 * - A save that fails, or waits on a retry, leaves the view refreshable. Until 2026-09-21
 *   a pending save held the view frozen to every change until a retry succeeded.
 *
 * Pure so the transitions are measured without Obsidian. `QueryView` does the effects.
 */
export class ViewState {
  private version = 0;
  private saving = false;
  private deferred = false;
  private stopped = false;

  /** Start a run. Null while a save is writing, or after `stop`. */
  begin(): RunToken | null {
    if (this.stopped || this.saving) return null;
    const version = ++this.version;
    this.deferred = false;
    return { current: () => !this.stopped && version === this.version };
  }

  /**
   * The note or the vault changed. `abort`: the current run is stale. `deferred`: a save
   * is writing; the view refreshes when it ends. `ignored`: the view is gone.
   */
  invalidate(): "abort" | "deferred" | "ignored" {
    if (this.stopped) return "ignored";
    if (this.saving) { this.deferred = true; return "deferred"; }
    this.version++;
    return "abort";
  }

  /** A write to a note begins. False when one is already writing or the view is gone. */
  beginSave(): boolean {
    if (this.stopped || this.saving) return false;
    this.saving = true;
    return true;
  }

  /** The write ended, however it ended. True when a change arrived meanwhile and the view must refresh. */
  endSave(): boolean {
    if (!this.saving) return false;
    this.saving = false;
    const refresh = this.deferred;
    this.deferred = false;
    return refresh;
  }

  stop(): void { this.stopped = true; this.version++; }
}
