import { describe, expect, it } from "vitest";
import { parseAllowedExternalUrl, ValidationError } from "../src/shared/api.js";

describe("external URL IPC validation", () => {
  it("accepts only the exact approved wallpaper and Apple hosts", () => {
    const approved = [
      "https://512pixels.net/projects/default-mac-wallpapers-in-5k/",
      "https://www.applewalls.com/en/macos-wallpapers",
      "https://basicappleguy.com/",
      "https://blackpixel.studio/",
      "https://www.apple.com/legal/",
      "https://developer.apple.com/documentation/",
      "https://support.apple.com/guide/mac-help/mchlp3013/mac",
    ];

    expect(approved.map(parseAllowedExternalUrl)).toEqual(approved);
  });

  it.each([
    "http://512pixels.net/projects/default-mac-wallpapers-in-5k/",
    "https://www.512pixels.net/projects/default-mac-wallpapers-in-5k/",
    "https://wallpapers.512pixels.net/",
    "https://512pixels.net.evil.example/",
    "https://user@basicappleguy.com/",
    "https://basicappleguy.com:443/",
    "https://blackpixel.studio:8443/",
  ])("rejects unapproved URL %s", (url) => {
    expect(() => parseAllowedExternalUrl(url)).toThrow(ValidationError);
  });
});
