// @vitest-environment node
import { expect, it } from "vitest";
import { hasWindowsUpdatePublisherName, isUpdateFeedConfigured } from "../../electron/main/update-config";

it("requires a non-empty publisher name for Windows update metadata", () => {
  expect(hasWindowsUpdatePublisherName("provider: generic\nurl: https://updates.example.test")).toBe(false);
  expect(hasWindowsUpdatePublisherName("publisherName: []")).toBe(false);
  expect(hasWindowsUpdatePublisherName("publisherName: { value: invalid-type }")).toBe(false);
  expect(hasWindowsUpdatePublisherName('publisherName: "" # intentionally empty')).toBe(false);
  expect(hasWindowsUpdatePublisherName("publisherName: CN=GitCrest, O=Example")).toBe(true);
  expect(hasWindowsUpdatePublisherName("publisherName:\n  - CN=GitCrest, O=Example\n  - CN=GitCrest Beta, O=Example")).toBe(true);
});

it("fails closed for Linux and requires trusted Windows publisher metadata", () => {
  expect(isUpdateFeedConfigured(false, "win32", "publisherName: CN=GitCrest")).toBe(false);
  expect(isUpdateFeedConfigured(true, "win32", undefined)).toBe(false);
  expect(isUpdateFeedConfigured(true, "win32", "provider: generic\nurl: https://updates.example.test")).toBe(false);
  expect(isUpdateFeedConfigured(true, "win32", "publisherName: CN=GitCrest")).toBe(true);
  expect(isUpdateFeedConfigured(true, "linux", "provider: generic\nurl: https://updates.example.test")).toBe(false);
  expect(isUpdateFeedConfigured(true, "linux", "provider: generic\nurl: https://updates.example.test\nsha512: is-not-a-signature")).toBe(false);
  expect(isUpdateFeedConfigured(true, "darwin", "provider: generic\nurl: https://updates.example.test")).toBe(true);
  expect(isUpdateFeedConfigured(true, "freebsd", "provider: generic\nurl: https://updates.example.test")).toBe(false);
});
