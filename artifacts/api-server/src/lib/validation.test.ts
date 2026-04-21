import { describe, it, expect } from "vitest";
import { parseUuidParam } from "./validation";

const VALID = "123e4567-e89b-12d3-a456-426614174000";

describe("parseUuidParam", () => {
  it("returns the UUID for a valid string", () => {
    expect(parseUuidParam(VALID)).toBe(VALID);
  });

  it("is case-insensitive", () => {
    const upper = VALID.toUpperCase();
    expect(parseUuidParam(upper)).toBe(upper);
  });

  it("returns the first element when given an array", () => {
    expect(parseUuidParam([VALID, "other"])).toBe(VALID);
  });

  it("returns null for undefined", () => {
    expect(parseUuidParam(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseUuidParam("")).toBeNull();
  });

  it("returns null for a non-UUID string", () => {
    expect(parseUuidParam("not-a-uuid")).toBeNull();
  });

  it("returns null for a UUID missing a segment", () => {
    expect(parseUuidParam("123e4567-e89b-12d3-a456")).toBeNull();
  });

  it("returns null for a UUID with extra characters", () => {
    expect(parseUuidParam(VALID + "x")).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parseUuidParam([])).toBeNull();
  });
});
