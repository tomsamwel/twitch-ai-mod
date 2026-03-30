import assert from "node:assert/strict";
import test from "node:test";

import { detectUrls } from "../src/moderation/url-detect.js";

test("detectUrls finds standard https URL", () => {
  const result = detectUrls("check https://example.com/path out");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 1);
  assert.match(result.urls[0]!, /example\.com/);
  assert.equal(result.obfuscated, false);
});

test("detectUrls finds standard http URL", () => {
  const result = detectUrls("go to http://scam-site.xyz/free");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 1);
});

test("detectUrls finds bare domain with common TLD", () => {
  const result = detectUrls("visit example.com for more");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 1);
  assert.equal(result.obfuscated, false);
});

test("detectUrls finds bare domain with path", () => {
  const result = detectUrls("check bit.ly/abc123");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 1);
});

test("detectUrls finds IP address URL", () => {
  const result = detectUrls("go to 192.168.1.1:8080/panel");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 1);
});

test("detectUrls detects obfuscated 'dot com' pattern", () => {
  const result = detectUrls("check scam-site dot com");
  assert.equal(result.detected, true);
  assert.equal(result.obfuscated, true);
});

test("detectUrls detects obfuscated '(dot)' pattern", () => {
  const result = detectUrls("visit mysite(dot)net now");
  assert.equal(result.detected, true);
  assert.equal(result.obfuscated, true);
});

test("detectUrls detects obfuscated '[dot]' pattern", () => {
  const result = detectUrls("free stuff at scam[dot]org");
  assert.equal(result.detected, true);
  assert.equal(result.obfuscated, true);
});

test("detectUrls does not flag normal conversation text", () => {
  const result = detectUrls("I like this community");
  assert.equal(result.detected, false);
  assert.equal(result.urls.length, 0);
});

test("detectUrls does not flag partial TLD-like words", () => {
  const result = detectUrls("the information is good");
  assert.equal(result.detected, false);
});

test("detectUrls deduplicates same URL appearing twice", () => {
  const result = detectUrls("visit https://example.com and https://example.com again");
  assert.equal(result.urls.length, 1);
});

test("detectUrls finds multiple different URLs", () => {
  const result = detectUrls("https://a.com and https://b.net");
  assert.equal(result.detected, true);
  assert.equal(result.urls.length, 2);
});

test("detectUrls handles empty string", () => {
  const result = detectUrls("");
  assert.equal(result.detected, false);
  assert.equal(result.urls.length, 0);
});

test("detectUrls finds .gg domain (common for Discord/gaming)", () => {
  const result = detectUrls("join discord.gg/invite");
  assert.equal(result.detected, true);
});

test("detectUrls finds .tv domain (Twitch links)", () => {
  const result = detectUrls("watch twitch.tv/streamer");
  assert.equal(result.detected, true);
});
