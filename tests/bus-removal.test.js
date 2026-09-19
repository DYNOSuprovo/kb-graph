import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_TARGETS } from '../src/migration-targets.js';
import { getHttpToolDefinitions, getToolDefinitions } from '../src/tools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('message bus removal', () => {
  it('has no bus tools, migration target, package bins, or source tree', () => {
    assert.deepEqual(getToolDefinitions().filter(tool => tool.name.startsWith('bus_')), []);
    assert.deepEqual(getHttpToolDefinitions().filter(tool => tool.name.startsWith('bus_')), []);
    assert.equal(MIGRATION_TARGETS.some(target => target.label === 'message bus'), false);
    assert.deepEqual(Object.keys(packageJson.bin).filter(name => name.startsWith('bus-')), []);
    assert.deepEqual(readdirSync(join(ROOT, 'bin')).filter(name => name.startsWith('bus-')), []);
    assert.equal(existsSync(join(ROOT, 'src', 'bus')), false);
  });
});
