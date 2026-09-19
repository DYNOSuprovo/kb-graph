import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_TARGETS } from '../src/migration-targets.js';
import { getHttpToolDefinitions, getToolDefinitions } from '../src/tools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const removedBusSurface = /\bbus[_-][a-z]/i;

function textFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    textFiles(join(path, entry.name))
  );
}

describe('message bus removal', () => {
  it('has no bus tools, migration target, package bins, or source tree', () => {
    assert.deepEqual(getToolDefinitions().filter(tool => tool.name.startsWith('bus_')), []);
    assert.deepEqual(getHttpToolDefinitions().filter(tool => tool.name.startsWith('bus_')), []);
    assert.equal(MIGRATION_TARGETS.some(target => target.label === 'message bus'), false);
    assert.deepEqual(Object.keys(packageJson.bin).filter(name => name.startsWith('bus-')), []);
    assert.deepEqual(readdirSync(join(ROOT, 'bin')).filter(name => name.startsWith('bus-')), []);
    assert.equal(existsSync(join(ROOT, 'src', 'bus')), false);
  });

  it('does not ship guidance for removed bus commands', () => {
    const guidanceFiles = [
      join(ROOT, 'README.md'),
      join(ROOT, 'llms.txt'),
      join(ROOT, '.env.example'),
      join(ROOT, 'CODEMAP.md'),
      join(ROOT, 'CONTRIBUTING.md'),
      join(ROOT, 'EXTENDING.md'),
      join(ROOT, 'openapi.json'),
      join(ROOT, 'kb-server-install.sh'),
      join(ROOT, 'kb-server.service.example'),
      ...textFiles(join(ROOT, 'docs')),
      ...textFiles(join(ROOT, 'skills')),
    ].filter(existsSync);
    const stale = guidanceFiles.filter(path =>
      removedBusSurface.test(readFileSync(path, 'utf8').replaceAll('bus-removal', ''))
    );
    assert.deepEqual(stale, []);
  });

  it('keeps public tool counts in sync after removing bus tools', () => {
    const toolCount = getToolDefinitions().length;
    const httpToolCount = getHttpToolDefinitions().length;
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    const comparison = readFileSync(join(ROOT, 'docs', 'SKILL-VS-MCP.md'), 'utf8');
    const statedToolCounts = [...comparison.matchAll(/\b(\d+) (?:KB )?tools\b/gi)]
      .map(([, count]) => Number(count));

    assert.match(llms, new RegExp(`All ${toolCount} tools available`));
    assert.ok(statedToolCounts.length > 0);
    assert.deepEqual([...new Set(statedToolCounts)], [toolCount]);
    assert.match(comparison, new RegExp(`${httpToolCount} are also exposed over HTTP`, 'i'));
    assert.match(
      comparison,
      new RegExp(`${toolCount - httpToolCount} administrative or local-only tools are stdio-only`, 'i'),
    );
  });
});
