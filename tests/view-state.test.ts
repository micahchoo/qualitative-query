import { describe, expect, it } from "vitest";
import { ViewState } from "../src/view-state";

describe("a Question view's state", () => {
  it("a change while running makes the run stale", () => {
    const state = new ViewState();
    const run = state.begin()!;
    expect(run.current()).toBe(true);
    expect(state.invalidate()).toBe("abort");
    expect(run.current()).toBe(false);
  });
  it("a newer run supersedes an older one", () => {
    const state = new ViewState();
    const first = state.begin()!, second = state.begin()!;
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
  });
  it("a change while saving is deferred, and the save ending asks for a refresh", () => {
    const state = new ViewState();
    const run = state.begin()!;
    expect(state.beginSave()).toBe(true);
    expect(state.begin()).toBeNull();
    expect(state.invalidate()).toBe("deferred");
    expect(run.current()).toBe(true);
    expect(state.endSave()).toBe(true);
  });
  it("a failed or pending save leaves the view refreshable", () => {
    const state = new ViewState();
    state.begin();
    state.beginSave();
    expect(state.endSave()).toBe(false);
    expect(state.begin()).not.toBeNull();
    expect(state.invalidate()).toBe("abort");
  });
  it("only one save writes at a time", () => {
    const state = new ViewState();
    expect(state.beginSave()).toBe(true);
    expect(state.beginSave()).toBe(false);
    state.endSave();
    expect(state.endSave()).toBe(false);
  });
  it("a stopped view runs nothing and ignores changes", () => {
    const state = new ViewState();
    const run = state.begin()!;
    state.stop();
    expect(run.current()).toBe(false);
    expect(state.begin()).toBeNull();
    expect(state.beginSave()).toBe(false);
    expect(state.invalidate()).toBe("ignored");
  });
});
