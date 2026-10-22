import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
describe('native AI runtime packaging', () => {
  it('builds and launches without an external AI worker', () => {
    for (const path of ['package.json', 'scripts/dev.mjs', 'scripts/package.mjs', 'scripts/package-smoke.mjs', 'apps/desktop/main/index.ts']) {
      expect(read(path), path).not.toMatch(/READER_AGENT|@reader\/agent|build:agent|agentPath|agent-path|agent\/smoke/);
    }
    expect(existsSync(resolve(root, 'apps/agent/package.json'))).toBe(false);
    expect(read('pnpm-lock.yaml')).not.toMatch(/@mariozechner\/pi-|apps\/agent:/);
  });
  it('retains the PDF worker and ordinary Reader client', () => {
    for (const path of ['scripts/dev.mjs', 'scripts/package-smoke.mjs', 'apps/desktop/main/index.ts']) {
      expect(read(path), path).toContain('READER_NODE');
      expect(read(path), path).toContain('READER_PROCESSOR');
    }
    expect(read('scripts/build-server.mjs')).toContain('["reader",');
    expect(read('scripts/package.mjs')).toContain('processor');
    expect(existsSync(resolve(root, 'apps/server/cmd/reader/main.go'))).toBe(true);
  });
});
