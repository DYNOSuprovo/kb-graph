import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import {
  assertSafeServiceSelection,
  assertSafeVaultSelection,
  setupJobPolicy,
  SetupVaultSafetyError,
} from '../src/cli/setup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('a populated KB accepts an empty vault only with an exact explicit confirmation', () => {
  assert.throws(
    () => assertSafeVaultSelection({
      candidatePath: '/tmp/new-empty-vault',
      priorPath: null,
      explicitVault: false,
      confirmation: null,
      documentCount: 20,
      candidateMarkdownCount: 0,
    }),
    SetupVaultSafetyError,
  );
  assert.throws(
    () => assertSafeVaultSelection({
      candidatePath: '/tmp/new-empty-vault',
      priorPath: null,
      explicitVault: true,
      confirmation: '/tmp/different-vault',
      documentCount: 20,
      candidateMarkdownCount: 0,
    }),
    SetupVaultSafetyError,
  );
  assert.doesNotThrow(() => assertSafeVaultSelection({
    candidatePath: '/tmp/new-empty-vault',
    priorPath: null,
    explicitVault: true,
    confirmation: '/tmp/new-empty-vault',
    documentCount: 20,
    candidateMarkdownCount: 0,
  }));
  assert.doesNotThrow(() => assertSafeVaultSelection({
    candidatePath: '/tmp/current-vault',
    priorPath: '/tmp/current-vault',
    explicitVault: false,
    confirmation: null,
    documentCount: 20,
    candidateMarkdownCount: 0,
  }));
  assert.throws(() => assertSafeVaultSelection({
    candidatePath: '',
    priorPath: '/tmp/current-vault',
    explicitVault: true,
    confirmation: null,
    documentCount: 20,
    candidateMarkdownCount: 0,
  }), SetupVaultSafetyError);
  assert.doesNotThrow(() => assertSafeVaultSelection({
    candidatePath: '',
    priorPath: '/tmp/current-vault',
    explicitVault: true,
    confirmation: 'none',
    documentCount: 20,
    candidateMarkdownCount: 0,
  }));
});

test('custom KB_DIR requires an explicit scheduler policy', () => {
  assert.deepEqual(
    setupJobPolicy([], { kbDir: '/tmp/test-kb', defaultKbDir: '/home/u/.knowledge-base' }),
    { installJobs: false, loadJobs: false },
  );
  assert.deepEqual(
    setupJobPolicy(['--no-load-jobs'], {
      kbDir: '/tmp/test-kb',
      defaultKbDir: '/home/u/.knowledge-base',
    }),
    { installJobs: true, loadJobs: false },
  );
  assert.throws(
    () => setupJobPolicy(['--load-jobs'], {
      kbDir: '/tmp/test-kb',
      defaultKbDir: '/home/u/.knowledge-base',
    }),
    /refused for a custom KB_DIR/,
  );
  assert.throws(
    () => setupJobPolicy(['--load-jobs', '--no-load-jobs']),
    /cannot be used together/,
  );
});

test('custom KB_DIR refuses global service installers', () => {
  const options = { kbDir: '/tmp/test-kb', defaultKbDir: '/home/u/.knowledge-base' };
  assert.doesNotThrow(() => assertSafeServiceSelection('manual', options));
  assert.doesNotThrow(() => assertSafeServiceSelection('docker', options));
  assert.throws(() => assertSafeServiceSelection('launchd', options), /service installation is refused/);
  assert.throws(() => assertSafeServiceSelection('systemd', options), /service installation is refused/);
});

test('automatic setup fails closed before creating the default empty vault or jobs', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'kb-setup-vault-safety-'));
  const home = join(sandbox, 'home');
  const kbDir = join(sandbox, 'kb');
  const candidate = join(sandbox, 'candidate');
  const fakeBin = join(sandbox, 'bin');
  const launchctlMarker = join(sandbox, 'launchctl-called');
  mkdirSync(home);
  mkdirSync(candidate);
  mkdirSync(fakeBin);
  const fakeLaunchctl = join(fakeBin, 'launchctl');
  writeFileSync(fakeLaunchctl, `#!/bin/sh\nprintf called > ${JSON.stringify(launchctlMarker)}\nexit 99\n`);
  chmodSync(fakeLaunchctl, 0o700);

  const env = {
    HOME: home,
    USER: 'fixture-user',
    KB_DIR: kbDir,
    OBSIDIAN_VAULT_PATH: candidate,
    KB_EMBEDDING_CACHE_DIR: join(sandbox, 'embedding-cache'),
    NODE_OPTIONS: '',
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'kb.js'), ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  try {
    const migrated = run('migrate');
    assert.equal(migrated.status, 0, migrated.stderr);
    const database = new Database(join(kbDir, 'kb.db'));
    database.prepare(
      "INSERT INTO documents (title, content, doc_type) VALUES ('existing', 'kept', 'note')"
    ).run();
    database.close();

    const refused = run(
      'setup', '--auto', '--password=fixture-password', '--agents=ollama',
      '--deploy=manual', '--no-load-jobs',
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to repoint a populated knowledge base/);
    assert.equal(existsSync(join(home, 'kb-vault')), false);
    assert.equal(existsSync(join(kbDir, '.env')), false);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
    assert.equal(existsSync(launchctlMarker), false);

    const unsafeService = run(
      'setup', '--auto', '--password=fixture-password', '--agents=ollama',
      '--deploy=launchd', `--vault=${candidate}`, `--confirm-empty-vault=${candidate}`,
      '--no-load-jobs',
    );
    assert.notEqual(unsafeService.status, 0);
    assert.match(unsafeService.stderr, /service installation is refused for a custom KB_DIR/);
    assert.equal(existsSync(join(kbDir, '.env')), false);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);

    const isolated = run(
      'setup', '--auto', '--password=fixture-password', '--agents=ollama',
      '--deploy=manual', `--vault=${candidate}`, `--confirm-empty-vault=${candidate}`,
    );
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.match(isolated.stdout, /Skipped scheduled jobs for custom KB_DIR/);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
    assert.equal(existsSync(launchctlMarker), false);

    const allowed = run(
      'setup', '--auto', '--password=fixture-password', '--agents=ollama',
      '--deploy=manual', `--vault=${candidate}`, `--confirm-empty-vault=${candidate}`,
      '--no-load-jobs',
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(readFileSync(join(kbDir, '.env'), 'utf8'), new RegExp(`OBSIDIAN_VAULT_PATH=${candidate}`));
    assert.equal(existsSync(launchctlMarker), false, '--no-load-jobs must never invoke launchctl');
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.kb.reindex.plist')));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
