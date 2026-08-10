import { describe, expect, it } from "vitest";
import { parseOutputFolderId, ValidationError } from "../src/shared/api.js";

describe("output folder IPC validation", () => {
  it("accepts only fixed output folder identifiers", () => {
    expect(parseOutputFolderId("screenshots")).toBe("screenshots");
    expect(parseOutputFolderId("recordings")).toBe("recordings");
    expect(parseOutputFolderId("exports")).toBe("exports");
    expect(() => parseOutputFolderId("C:\\Users\\User")).toThrow(ValidationError);
    expect(() => parseOutputFolderId("../exports")).toThrow(ValidationError);
  });
});
