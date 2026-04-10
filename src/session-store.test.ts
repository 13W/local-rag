import { describe, it, expect, beforeEach } from "vitest";
import { setSession, getSession, clearStore } from "./session-store.js";

beforeEach(() => clearStore());

describe("SessionStore", () => {
  it("returns undefined when nothing stored", () => {
    expect(getSession("proj", "agent")).toBeUndefined();
  });

  it("stores and retrieves session_id", () => {
    setSession("proj", "agent", "sess-123");
    expect(getSession("proj", "agent")).toBe("sess-123");
  });

  it("overwrites previous session_id", () => {
    setSession("proj", "agent", "old");
    setSession("proj", "agent", "new");
    expect(getSession("proj", "agent")).toBe("new");
  });

  it("returns undefined for expired entries", () => {
    setSession("proj", "agent", "expired", -1);
    expect(getSession("proj", "agent")).toBeUndefined();
  });

  it("different project/agent keys are independent", () => {
    setSession("proj-a", "agent", "sess-a");
    setSession("proj-b", "agent", "sess-b");
    expect(getSession("proj-a", "agent")).toBe("sess-a");
    expect(getSession("proj-b", "agent")).toBe("sess-b");
  });
});
