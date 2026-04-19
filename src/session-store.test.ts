import { describe, it, expect, beforeEach } from "vitest";
import { setSession, getSession, clearStore } from "./session-store.js";

beforeEach(() => clearStore());

describe("SessionStore", () => {
  it("returns undefined when nothing stored", () => {
    expect(getSession("proj")).toBeUndefined();
  });

  it("stores and retrieves session_id", () => {
    setSession("proj", "sess-123");
    expect(getSession("proj")).toBe("sess-123");
  });

  it("overwrites previous session_id", () => {
    setSession("proj", "old");
    setSession("proj", "new");
    expect(getSession("proj")).toBe("new");
  });

  it("returns undefined for expired entries", () => {
    setSession("proj", "expired", -1);
    expect(getSession("proj")).toBeUndefined();
  });

  it("different project keys are independent", () => {
    setSession("proj-a", "sess-a");
    setSession("proj-b", "sess-b");
    expect(getSession("proj-a")).toBe("sess-a");
    expect(getSession("proj-b")).toBe("sess-b");
  });
});
