import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("next.config.ts enforces strict security headers and CSP rules", () => {
  const config = readFileSync("next.config.ts", "utf8");

  assert.match(config, /Content-Security-Policy/);
  assert.match(config, /default-src\s+['"]self['"]/);
  assert.match(config, /script-src\s+['"]self['"]/);
  assert.doesNotMatch(config, /script-src\s+[^;]*unsafe-eval/);
  assert.match(config, /connect-src\s+['"]self['"][\s\S]*https:\/\/horizon-testnet\.stellar\.org/);
  assert.match(config, /connect-src\s+['"]self['"][\s\S]*https:\/\/soroban-testnet\.stellar\.org/);
  assert.match(config, /connect-src\s+['"]self['"][\s\S]*https:\/\/friendbot\.stellar\.org/);
  assert.match(config, /connect-src\s+['"]self['"][\s\S]*http:\/\/localhost:3000/);
  assert.match(config, /connect-src\s+['"]self['"][\s\S]*http:\/\/localhost:3001/);
  assert.match(config, /X-Frame-Options\s*[,\s]*.*DENY|X-Frame-Options\s*:\s*DENY/);
  assert.match(
    config,
    /X-Content-Type-Options\s*[,\s]*.*nosniff|X-Content-Type-Options\s*:\s*nosniff/,
  );
  assert.match(
    config,
    /Referrer-Policy\s*[,\s]*.*strict-origin-when-cross-origin|Referrer-Policy\s*:\s*strict-origin-when-cross-origin/,
  );
});
