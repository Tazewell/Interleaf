import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
describe('native AI runtime packaging', () => {
  it('builds and launches without an external AI worker', () => {
    for (const path of ['package.json', 'scripts/dev.mjs', 'scripts/package.mjs', 'scripts/package-smoke.mjs', 'apps/desktop/main/index.ts']) {
      expect(read(path), path).not.toMatch(/INTERLEAF_AGENT|@interleaf\/agent|build:agent|agentPath|agent-path|agent\/smoke/);
    }
    expect(existsSync(resolve(root, 'apps/agent/package.json'))).toBe(false);
    expect(read('pnpm-lock.yaml')).not.toMatch(/@(?:mariozechner|earendil-works)\/pi-|apps\/agent:/);
  });
  it('keeps the production dependency and packaged entry closure free of retired runtimes', () => {
    const retired = /@(?:mariozechner|earendil-works)\/pi-|@interleaf\/agent/;
    for (const parent of ['apps', 'packages']) {
      for (const directory of readdirSync(resolve(root, parent))) {
        const path = `${parent}/${directory}/package.json`;
        if (!existsSync(resolve(root, path))) continue;
        const manifest = JSON.parse(read(path));
        expect(JSON.stringify([manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]), path).not.toMatch(retired);
      }
    }
    for (const path of ['apps/desktop/build.mjs', 'apps/processor/build.mjs', 'scripts/build-server.mjs', 'scripts/prepare-assets.mjs', 'apps/server/cmd/interleaf-server/main.go']) {
      expect(read(path), path).not.toMatch(/INTERLEAF_AGENT|@interleaf\/agent|@(?:mariozechner|earendil-works)\/pi-|agentPath|agent-path/);
    }
  });
  it('retains the PDF worker and ordinary Interleaf client', () => {
    for (const path of ['scripts/dev.mjs', 'scripts/package-smoke.mjs', 'apps/desktop/main/index.ts']) {
      expect(read(path), path).toContain('INTERLEAF_NODE');
      expect(read(path), path).toContain('INTERLEAF_PROCESSOR');
    }
    expect(read('scripts/build-server.mjs')).toContain('["interleaf",');
    expect(read('scripts/package.mjs')).toContain('processor');
    expect(existsSync(resolve(root, 'apps/server/cmd/interleaf/main.go'))).toBe(true);
  });
});
