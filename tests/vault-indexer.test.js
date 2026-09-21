// Must come first: this file indexes notes through getDb(), so without it the
// run opens the real ~/.knowledge-base/kb.db, migrates it, and writes rows into
// it — which is what the delete-on-the-way-out below was compensating for.
import './helpers/tmp-kb.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import { getDb, getHealth, listDocuments, searchDocuments } from '../src/db.js';
import {
  evaluatePruneSafety,
  indexVault,
  indexVaultFile,
  pruneLimit,
  pruneMissingVaultFiles,
  scanVault,
  VAULT_INDEX_RACE_LOG,
  VAULT_INDEX_SAFETY_LOG,
  VaultPruneRefusedError,
} from '../src/vault/indexer.js';
import { parseVaultReindexArgs } from '../src/cli/vault-cli.js';
import { CORPUS_PATH, TRIGGER_INDEX_PATH, loadTriggerIndex, rebuildTriggerIndex } from '../src/trigger-relevance.js';
import { relevantNotes } from '../src/hint-relevance.js';
import { buildContextPacket } from '../src/context-packet.js';
import { storeEmbedding } from '../src/embeddings/embed.js';

// The indexer's triggers wiring uses filterTriggers's DEFAULT corpus (no
// explicit `corpus` option), which reads CORPUS_PATH — so these tests write
// a real TSV there rather than passing a synthetic array the way
// tests/triggers.test.js does. 40 sessions x 20 filler lines (>=500 lines,
// >=20 sessions, the corpus-adequacy floor) plus two markers: one common
// enough to be rejected by the 5% session ceiling, one rare enough to clear
// it.
function writeTestCorpus() {
  const lines = [];
  for (let s = 0; s < 40; s += 1) {
    for (let j = 0; j < 20; j += 1) lines.push(`s${s}\t${j % 2 === 0 ? 'git status' : 'ls -la'}`);
  }
  for (let s = 0; s < 4; s += 1) lines.push(`s${s}\tgit push --force`); // 4/40 = 10% -> rejected
  lines.push('s10\trare-marker-cmd run'); // 1/40 = 2.5% -> accepted
  writeFileSync(CORPUS_PATH, lines.join('\n') + '\n');
}

function deleteIndexedPath(relPath) {
  const database = getDb();
  const row = database.prepare(
    'SELECT document_id FROM vault_files WHERE vault_path = ?'
  ).get(relPath);
  if (row?.document_id) {
    database.prepare(`
      INSERT OR REPLACE INTO document_tombstones (
        document_id, vault_path, content_hash, detached_at, reason
      )
      SELECT d.id, vf.vault_path, vf.content_hash, d.detached_at, 'detached_grace_expired'
      FROM documents d
      JOIN vault_files vf ON vf.document_id = d.id
      WHERE d.id = ? AND vf.vault_path = ?
    `).run(row.document_id, relPath);
  }
  database.prepare('DELETE FROM vault_files WHERE vault_path = ?').run(relPath);
  if (row?.document_id) database.prepare('DELETE FROM documents WHERE id = ?').run(row.document_id);
  if (row?.document_id) {
    database.prepare('DELETE FROM document_tombstones WHERE document_id = ?').run(row.document_id);
  }
}

function deleteIndexedPrefix(pattern) {
  const paths = getDb().prepare(
    'SELECT vault_path FROM vault_files WHERE vault_path LIKE ?'
  ).all(pattern);
  for (const { vault_path: vaultPath } of paths) deleteIndexedPath(vaultPath);
}

function reindexInChild(vaultPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'vault-reindex-child.js'), vaultPath],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`child reindex exited ${code}: ${stderr}`));
    });
  });
}

describe('scanVault', () => {
  let vaultDir;

  before(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'test-vault-'));
    mkdirSync(join(vaultDir, '05_research'), { recursive: true });
    mkdirSync(join(vaultDir, '.obsidian'), { recursive: true });
    symlinkSync(join(tmpdir(), 'missing-vault-link'), join(vaultDir, 'broken-link'));

    writeFileSync(join(vaultDir, '05_research', 'test.md'), `---
title: Test Research
type: research
tags: [ai]
project: kb-system
---

# Test Research

Some research content.`);

    writeFileSync(join(vaultDir, '.obsidian', 'config.json'), '{}');
    writeFileSync(join(vaultDir, '05_research', '.DS_Store'), 'junk');
  });

  after(() => rmSync(vaultDir, { recursive: true, force: true }));

  it('should find markdown files and skip system folders', () => {
    const files = scanVault(vaultDir);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].endsWith('test.md'));
  });

  it('should skip broken symlinks without aborting the scan', () => {
    const files = scanVault(vaultDir);
    assert.strictEqual(files.length, 1);
  });

  it('should index one vault file without scanning the whole vault', async () => {
    const relPath = '05_research/single-file-index.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Single File Index Test
type: research
tags: [single-file-index]
---

Only this note should need indexing.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(
        { indexed: result.indexed, skipped: result.skipped, deleted: result.deleted, errors: result.errors },
        { indexed: 1, skipped: 0, deleted: 0, errors: [] }
      );

      const row = getDb().prepare('SELECT title, doc_type, tags FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.title, 'Single File Index Test');
      assert.strictEqual(row.doc_type, 'research');
      assert.match(row.tags, /single-file-index/);
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('stores frontmatter aliases only after the filter has vetted them', async () => {
    const relPath = '05_research/aliased-note.md';
    // "indexer" is the body's word, "vectorizer" is nobody's — the filter
    // keeps the first and drops the second (tests/aliases.test.js owns the
    // full gate; this pins the wiring from frontmatter to column).
    writeFileSync(join(vaultDir, relPath), `---
title: Only the write path embeds a note
type: research
tags: [embedding-plumbing]
aliases: [indexer, vectorizer]
---

The vault indexer is what embeds a document after a write.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT aliases FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.aliases, 'indexer');
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('vets frontmatter triggers into the column — one accepted, one rejected by the session ceiling', async () => {
    writeTestCorpus();
    const relPath = '05_research/trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Force-push cleanup
type: lesson
tags: [git]
triggers: ["git push && --force", "rare-marker-cmd"]
---

Never run \`git push --force\` here; also watch for \`rare-marker-cmd\`.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      const kept = JSON.parse(row.triggers);
      assert.deepStrictEqual(kept.map(k => k.parts), [['rare-marker-cmd']]);

      const index = loadTriggerIndex(TRIGGER_INDEX_PATH);
      const entry = index.find(e => e.id === row.id);
      assert.ok(entry, 'rebuildTriggerIndex must have run and picked up the new column');
      assert.deepStrictEqual(entry.patterns.map(p => p.parts), [['rare-marker-cmd']]);
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('honors triggers_pinned, keeping a pattern the session ceiling would otherwise reject', async () => {
    writeTestCorpus();
    const relPath = '05_research/pinned-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Force-push cleanup (curated)
type: lesson
tags: [git]
triggers: ["git push && --force"]
triggers_pinned: true
---

Never run \`git push --force\` here.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      const kept = JSON.parse(row.triggers);
      assert.deepStrictEqual(kept.map(k => k.parts), [['git push', '--force']]);
      assert.strictEqual(kept[0].pinned, true);
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('carries a human-pinned triggers_block policy into the resident hook index', async () => {
    writeTestCorpus();
    const relPath = '05_research/blocking-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Never delete a stacked PR base
type: lesson
tags: [git]
tier: observed
triggers: ["gh pr merge && --delete-branch"]
triggers_pinned: true
triggers_block: true
---

Never run \`gh pr merge --delete-branch\` on the base of a stacked PR.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      const kept = JSON.parse(row.triggers);
      assert.strictEqual(kept[0].block, true);

      const entry = loadTriggerIndex(TRIGGER_INDEX_PATH).find(e => e.id === row.id);
      assert.strictEqual(entry.block, true);
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('stores NULL, never an empty string, when nothing survives the vet', async () => {
    writeTestCorpus();
    const relPath = '05_research/no-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: A note with no groundable command
type: lesson
tags: [git]
triggers: ["totally-unrelated-command"]
---

This note only describes totally-unrelated-command in prose, never inside a code span.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.strictEqual(row.triggers, null);
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('a malformed triggers row elsewhere does not block rebuilding the index for a good note (B1)', async () => {
    writeTestCorpus();
    // Simulate a corrupted row from a past write (hand SQL edit, a partial
    // write) — the only way malformed JSON could land in this column, since
    // filterTriggers only ever produces valid JSON or ''.
    const bad = getDb().prepare('INSERT INTO documents (title, content, doc_type, tags, triggers) VALUES (?, ?, ?, ?, ?)')
      .run('Corrupted trigger row', 'x', 'lesson', '', '{not valid json');

    const relPath = '05_research/good-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Good trigger note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.deepStrictEqual(result.errors, []);
      const row = getDb().prepare('SELECT id FROM documents WHERE source = ?').get(`vault:${relPath}`);

      const index = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(index.some(e => e.id === row.id), 'the good note must still appear in the rebuilt index');
      assert.ok(!index.some(e => e.id === bad.lastInsertRowid), 'the bad row is skipped, not left to crash the rebuild');
    } finally {
      deleteIndexedPath(relPath);
      getDb().prepare('DELETE FROM documents WHERE id = ?').run(bad.lastInsertRowid);
    }
  });

  it('defers the index rebuild when asked — column changes, index waits for an explicit rebuild (B2)', async () => {
    writeTestCorpus();
    const relPath = '05_research/deferred-trigger-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Deferred trigger note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath, { deferTriggerIndex: true });
      assert.strictEqual(result.triggersChanged, true);
      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.ok(row.triggers, 'the column updates regardless of deferral');

      const beforeExplicitRebuild = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(!beforeExplicitRebuild.some(e => e.id === row.id), 'a deferred call must not rebuild inline');

      rebuildTriggerIndex();
      const afterExplicitRebuild = loadTriggerIndex(TRIGGER_INDEX_PATH);
      assert.ok(afterExplicitRebuild.some(e => e.id === row.id), 'an explicit rebuild picks up the deferred change');
    } finally {
      deleteIndexedPath(relPath);
    }
  });

  it('an indexer upsert survives a trigger-index rebuild failure, vault_files row still recorded (B1)', async () => {
    writeTestCorpus();
    // An unwritable index location: a directory sitting where the atomic
    // rename needs to land a file makes renameSync throw EISDIR. Clear
    // whatever an earlier test already left at this path first (a real
    // trigger-index.json, most likely) — mkdirSync fails on an existing file.
    rmSync(TRIGGER_INDEX_PATH, { recursive: true, force: true });
    mkdirSync(TRIGGER_INDEX_PATH);
    const relPath = '05_research/rebuild-failure-note.md';
    writeFileSync(join(vaultDir, relPath), `---
title: Rebuild failure note
type: lesson
tags: [git]
triggers: ["rare-marker-cmd"]
---

Watch for \`rare-marker-cmd\` in history.`);

    try {
      const result = await indexVaultFile(vaultDir, relPath);
      assert.strictEqual(result.indexed, 1, 'the write itself must not abort');
      assert.match(result.errors.join(' '), /trigger index rebuild failed/);

      const row = getDb().prepare('SELECT id, triggers FROM documents WHERE source = ?').get(`vault:${relPath}`);
      assert.ok(row.triggers, 'the column write itself still lands');

      const vf = getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?').get(relPath);
      assert.strictEqual(vf.document_id, row.id, 'the vault_files row is still recorded despite the rebuild failure');
    } finally {
      rmSync(TRIGGER_INDEX_PATH, { recursive: true, force: true });
      deleteIndexedPath(relPath);
    }
  });

  it('should reject single-file indexing outside the vault', async () => {
    const outsideFile = join(tmpdir(), 'outside-kb-vault.md');
    writeFileSync(outsideFile, '# Outside');

    try {
      const result = await indexVaultFile(vaultDir, outsideFile);
      assert.strictEqual(result.indexed, 0);
      assert.match(result.errors[0], /outside vault/);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it('does not delete an acknowledged note that appears after a full-vault scan', () => {
    const relPath = '05_research/concurrent-write.md';
    const filePath = join(vaultDir, relPath);
    const doc = getDb().prepare(
      'INSERT INTO documents (title, content, source, doc_type, file_path) VALUES (?, ?, ?, ?, ?)'
    ).run('Concurrent write', 'Acknowledged before the stale scan pruned.', `vault:${relPath}`, 'research', filePath);
    getDb().prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, ?)'
    ).run(relPath, 'new-write-hash', doc.lastInsertRowid, 'Concurrent write', 'research');
    writeFileSync(filePath, '# Concurrent write\n\nStill present on disk.');

    try {
      const result = pruneMissingVaultFiles(vaultDir, new Map([[relPath, 'old-scan-hash']]), new Set());

      assert.deepStrictEqual(result, { deleted: 0, detached: 0, preserved: 1 });
      assert.ok(getDb().prepare('SELECT 1 FROM documents WHERE id = ?').get(doc.lastInsertRowid));
      assert.ok(getDb().prepare('SELECT 1 FROM vault_files WHERE vault_path = ?').get(relPath));
      const event = JSON.parse(readFileSync(VAULT_INDEX_RACE_LOG, 'utf8').trim().split('\n').at(-1));
      assert.deepStrictEqual(
        { event: event.event, vault_path: event.vault_path },
        { event: 'delete_skipped_file_present', vault_path: relPath },
      );
    } finally {
      rmSync(filePath, { force: true });
      deleteIndexedPath(relPath);
    }
  });

  it('detaches an indexed note whose source file is actually gone', () => {
    const relPath = '05_research/actually-deleted.md';
    const doc = getDb().prepare(
      'INSERT INTO documents (title, content, source, doc_type) VALUES (?, ?, ?, ?)'
    ).run('Actually deleted', 'No source file remains.', `vault:${relPath}`, 'research');
    getDb().prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, ?)'
    ).run(relPath, 'deleted-hash', doc.lastInsertRowid, 'Actually deleted', 'research');

    const result = pruneMissingVaultFiles(vaultDir, new Map([[relPath, 'deleted-hash']]), new Set());

    assert.deepStrictEqual(result, { deleted: 1, detached: 1, preserved: 0 });
    assert.ok(getDb().prepare(
      'SELECT 1 FROM documents WHERE id = ? AND detached_at IS NOT NULL'
    ).get(doc.lastInsertRowid));
    assert.ok(getDb().prepare(
      'SELECT 1 FROM vault_files WHERE vault_path = ? AND missing_at IS NOT NULL'
    ).get(relPath));
    deleteIndexedPath(relPath);
  });

  it('removes detached trigger notes from the materialized hook index', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-trigger-detach-'));
    const relPath = 'notes/trigger.md';
    mkdirSync(join(isolatedVault, 'notes'));
    const note = `---
title: Trigger detach
triggers: ["rare-marker-cmd"]
---
\`rare-marker-cmd run\``;
    writeFileSync(join(isolatedVault, relPath), note);

    try {
      writeTestCorpus();
      await indexVault(isolatedVault);
      const documentId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(relPath).document_id;
      assert.ok(loadTriggerIndex().some(entry => entry.id === documentId));

      unlinkSync(join(isolatedVault, relPath));
      await indexVault(isolatedVault, { confirmPrune: 1 });
      assert.ok(!loadTriggerIndex().some(entry => entry.id === documentId));

      writeFileSync(join(isolatedVault, relPath), note);
      await indexVaultFile(isolatedVault, relPath);
      assert.ok(
        loadTriggerIndex().some(entry => entry.id === documentId),
        'single-file same-path reattachment must rematerialize unchanged triggers',
      );
    } finally {
      deleteIndexedPath(relPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('preserves identity and lifecycle through edits, absence, and same-path return', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-return-'));
    const relPath = 'state/stable.md';
    const filePath = join(isolatedVault, relPath);
    mkdirSync(join(isolatedVault, 'state'));
    writeFileSync(filePath, `---
title: Stable state
type: state
tier: verified
tier_ref: commit abc1234
---

original identity body`);

    try {
      await indexVault(isolatedVault);
      const first = getDb().prepare(
        'SELECT id, created_at FROM documents WHERE source = ?'
      ).get(`vault:${relPath}`);
      getDb().prepare(`
        UPDATE documents
        SET superseded_at = '2026-09-20 12:00:00',
            superseded_by = 999,
            superseded_reason = 'identity sentinel'
        WHERE id = ?
      `).run(first.id);

      writeFileSync(filePath, `---
title: Stable state edited
type: state
tier: observed
---

edited while attached`);
      await indexVault(isolatedVault);
      assert.strictEqual(
        getDb().prepare('SELECT id FROM documents WHERE source = ?').get(`vault:${relPath}`).id,
        first.id,
      );
      getDb().prepare(`
        UPDATE documents
        SET tier = 'verified', tier_ref = 'commit promoted-after-index'
        WHERE id = ?
      `).run(first.id);
      getDb().prepare(`
        INSERT INTO embeddings (
          document_id, vault_path, chunk_index, chunk_text, embedding, dimensions
        ) VALUES (?, ?, 0, 'edited while attached', ?, 1)
      `).run(first.id, relPath, Buffer.from(new Float32Array([1]).buffer));

      unlinkSync(filePath);
      const detached = await indexVault(isolatedVault, { confirmPrune: 1 });
      assert.strictEqual(detached.detached, 1);
      assert.strictEqual(searchDocuments('edited while attached').length, 0);
      assert.ok(!listDocuments({ includeSuperseded: true }).some(doc => doc.id === first.id));
      assert.ok(!relevantNotes('edited while attached').some(doc => doc.id === first.id));
      assert.ok(!buildContextPacket(getDb(), {
        query: 'edited while attached',
        limit: 10,
      }).documents.some(doc => doc.id === first.id));
      assert.strictEqual(
        getDb().prepare('SELECT COUNT(*) AS count FROM embeddings WHERE document_id = ?').get(first.id).count,
        0,
      );

      writeFileSync(filePath, `---
title: Stable state returned
type: state
tier: inferred
---

returned with a content edit`);
      await indexVault(isolatedVault);
      const returned = getDb().prepare(`
        SELECT id, tier, tier_ref, created_at, detached_at,
               superseded_at, superseded_by, superseded_reason
        FROM documents WHERE id = ?
      `).get(first.id);
      assert.deepStrictEqual(returned, {
        id: first.id,
        tier: 'verified',
        tier_ref: 'commit promoted-after-index',
        created_at: first.created_at,
        detached_at: null,
        superseded_at: '2026-09-20 12:00:00',
        superseded_by: 999,
        superseded_reason: 'identity sentinel',
      });
      assert.strictEqual(
        getDb().prepare('SELECT document_id, missing_at FROM vault_files WHERE vault_path = ?')
          .get(relPath).document_id,
        first.id,
      );
    } finally {
      deleteIndexedPath(relPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('reattaches a unique exact-content rename but never guesses rename plus edit', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-rename-'));
    const originalPath = 'research/original.md';
    const renamedPath = 'research/renamed.md';
    const editedPath = 'research/edited-name.md';
    mkdirSync(join(isolatedVault, 'research'));
    writeFileSync(join(isolatedVault, originalPath), '# Identity rename\n\nsame exact bytes');

    try {
      await indexVault(isolatedVault);
      const originalId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(originalPath).document_id;

      renameSync(join(isolatedVault, originalPath), join(isolatedVault, renamedPath));
      const renamed = await indexVault(isolatedVault);
      assert.strictEqual(renamed.detached, 0);
      assert.strictEqual(
        getDb().prepare('SELECT document_id FROM vault_files WHERE vault_path = ?')
          .get(renamedPath).document_id,
        originalId,
      );

      renameSync(join(isolatedVault, renamedPath), join(isolatedVault, editedPath));
      writeFileSync(join(isolatedVault, editedPath), '# Identity rename\n\nbytes changed during rename');
      await indexVault(isolatedVault);
      const editedId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(editedPath).document_id;
      assert.notStrictEqual(editedId, originalId);
      assert.ok(getDb().prepare(
        'SELECT 1 FROM documents WHERE id = ? AND detached_at IS NOT NULL'
      ).get(originalId));
    } finally {
      deleteIndexedPath(originalPath);
      deleteIndexedPath(renamedPath);
      deleteIndexedPath(editedPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('keeps one identity when separate reindex processes race on a rename', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-concurrent-'));
    const originalPath = 'notes/before.md';
    const renamedPath = 'notes/after.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, originalPath), '# Concurrent identity\n\nsame bytes');

    try {
      await indexVault(isolatedVault);
      const originalId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(originalPath).document_id;
      renameSync(join(isolatedVault, originalPath), join(isolatedVault, renamedPath));

      await Promise.all([
        reindexInChild(isolatedVault),
        reindexInChild(isolatedVault),
      ]);
      assert.deepStrictEqual(
        getDb().prepare(`
          SELECT vault_path, document_id, missing_at
          FROM vault_files
          WHERE vault_path IN (?, ?)
          ORDER BY vault_path
        `).all(originalPath, renamedPath),
        [{ vault_path: renamedPath, document_id: originalId, missing_at: null }],
      );
      assert.strictEqual(
        getDb().prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE title = 'Concurrent identity'"
        ).get().count,
        1,
      );
    } finally {
      deleteIndexedPath(originalPath);
      deleteIndexedPath(renamedPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('keeps one identity when separate processes index a new path concurrently', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-concurrent-new-'));
    const relPath = 'notes/new.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, relPath), '# Concurrent new identity\n\nsame bytes');

    try {
      await Promise.all([
        reindexInChild(isolatedVault),
        reindexInChild(isolatedVault),
      ]);
      const tracked = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(relPath);
      assert.ok(tracked?.document_id);
      assert.strictEqual(
        getDb().prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE title = 'Concurrent new identity'"
        ).get().count,
        1,
      );
    } finally {
      deleteIndexedPath(relPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('never treats a legacy truncated hash as exact rename identity', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-legacy-hash-'));
    const fromPath = 'notes/legacy-before.md';
    const toPath = 'notes/legacy-after.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, fromPath), '# Legacy hash\n\nsame bytes');

    try {
      await indexVault(isolatedVault);
      const original = getDb().prepare(
        'SELECT document_id, content_hash FROM vault_files WHERE vault_path = ?'
      ).get(fromPath);
      getDb().prepare(
        'UPDATE vault_files SET content_hash = ? WHERE vault_path = ?'
      ).run(original.content_hash.slice(0, 16), fromPath);
      renameSync(join(isolatedVault, fromPath), join(isolatedVault, toPath));
      await indexVault(isolatedVault);

      assert.notStrictEqual(
        getDb().prepare(
          'SELECT document_id FROM vault_files WHERE vault_path = ?'
        ).get(toPath).document_id,
        original.document_id,
      );
      assert.ok(getDb().prepare(
        'SELECT 1 FROM documents WHERE id = ? AND detached_at IS NOT NULL'
      ).get(original.document_id));
    } finally {
      deleteIndexedPath(fromPath);
      deleteIndexedPath(toPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('does not restore an embedding after its document was detached', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-embedding-detach-'));
    const relPath = 'notes/embedding.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, relPath), '# Detached embedding\n\nrace sentinel');

    try {
      await indexVault(isolatedVault);
      const documentId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(relPath).document_id;
      unlinkSync(join(isolatedVault, relPath));
      await indexVault(isolatedVault, { confirmPrune: 1 });

      assert.strictEqual(
        await storeEmbedding(documentId, 'race sentinel', relPath),
        0,
      );
      assert.strictEqual(
        getDb().prepare(
          'SELECT COUNT(*) AS count FROM embeddings WHERE document_id = ?'
        ).get(documentId).count,
        0,
      );
    } finally {
      deleteIndexedPath(relPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous hash identity and only reattaches a path missing in that scan', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-ambiguous-'));
    const oldPath = 'notes/old.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, oldPath), '# Duplicate bytes\n\nsame');

    try {
      await indexVault(isolatedVault);
      const oldId = getDb().prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(oldPath).document_id;
      unlinkSync(join(isolatedVault, oldPath));
      writeFileSync(join(isolatedVault, 'notes/new-a.md'), '# Duplicate bytes\n\nsame');
      writeFileSync(join(isolatedVault, 'notes/new-b.md'), '# Duplicate bytes\n\nsame');
      await indexVault(isolatedVault);

      const ids = getDb().prepare(`
        SELECT document_id FROM vault_files
        WHERE vault_path IN ('notes/new-a.md', 'notes/new-b.md')
        ORDER BY vault_path
      `).all().map(row => row.document_id);
      assert.ok(ids.every(id => id !== oldId));
      assert.notStrictEqual(ids[0], ids[1]);
      assert.ok(getDb().prepare(
        'SELECT 1 FROM documents WHERE id = ? AND detached_at IS NOT NULL'
      ).get(oldId));

      unlinkSync(join(isolatedVault, 'notes/new-a.md'));
      unlinkSync(join(isolatedVault, 'notes/new-b.md'));
      await indexVault(isolatedVault, { confirmPrune: 2 });
      writeFileSync(join(isolatedVault, 'notes/later.md'), '# Duplicate bytes\n\nsame');
      await indexVault(isolatedVault);
      assert.notStrictEqual(
        getDb().prepare(
          "SELECT document_id FROM vault_files WHERE vault_path = 'notes/later.md'"
        ).get().document_id,
        oldId,
        'an already-detached path did not vanish in the later scan',
      );
    } finally {
      for (const path of [oldPath, 'notes/new-a.md', 'notes/new-b.md', 'notes/later.md']) {
        deleteIndexedPath(path);
      }
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('rolls back a new document when vault tracking fails mid-index', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-crash-'));
    const relPath = 'notes/crash.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, relPath), '# Crash sentinel\n\nmust stay atomic');
    const database = getDb();
    database.exec(`
      CREATE TRIGGER fail_crash_vault_insert
      BEFORE INSERT ON vault_files
      WHEN new.vault_path = 'notes/crash.md'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic vault tracking interruption');
      END;
    `);
    try {
      await assert.rejects(
        indexVaultFile(isolatedVault, relPath),
        /synthetic vault tracking interruption/,
      );
      assert.strictEqual(
        database.prepare("SELECT COUNT(*) AS count FROM documents WHERE title = 'Crash sentinel'").get().count,
        0,
      );
      assert.strictEqual(
        database.prepare("SELECT COUNT(*) AS count FROM vault_files WHERE vault_path = 'notes/crash.md'").get().count,
        0,
      );
    } finally {
      database.exec('DROP TRIGGER fail_crash_vault_insert');
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('rolls back an exact rename when document reattachment is interrupted', async () => {
    const isolatedVault = mkdtempSync(join(tmpdir(), 'kb-identity-rename-crash-'));
    const fromPath = 'notes/before-crash.md';
    const toPath = 'notes/after-crash.md';
    mkdirSync(join(isolatedVault, 'notes'));
    writeFileSync(join(isolatedVault, fromPath), '# Rename crash\n\nsame content');
    const database = getDb();

    try {
      await indexVault(isolatedVault);
      const original = database.prepare(
        'SELECT document_id FROM vault_files WHERE vault_path = ?'
      ).get(fromPath);
      renameSync(join(isolatedVault, fromPath), join(isolatedVault, toPath));
      database.exec(`
        CREATE TRIGGER fail_rename_document_update
        BEFORE UPDATE ON documents
        WHEN old.id = ${Number(original.document_id)}
          AND new.source = 'vault:${toPath}'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic rename interruption');
        END;
      `);

      const result = await indexVault(isolatedVault);
      assert.ok(result.errors.some(error => error.includes('synthetic rename interruption')));
      assert.deepStrictEqual(
        database.prepare(`
          SELECT vault_path, document_id
          FROM vault_files
          WHERE document_id = ?
        `).all(original.document_id),
        [{ vault_path: fromPath, document_id: original.document_id }],
      );
      assert.strictEqual(
        database.prepare('SELECT source FROM documents WHERE id = ?').get(original.document_id).source,
        `vault:${fromPath}`,
      );
      database.exec('DROP TRIGGER fail_rename_document_update');
      await indexVault(isolatedVault);
      assert.strictEqual(
        database.prepare(
          'SELECT document_id FROM vault_files WHERE vault_path = ?'
        ).get(toPath).document_id,
        original.document_id,
      );
    } finally {
      database.exec('DROP TRIGGER IF EXISTS fail_rename_document_update');
      deleteIndexedPath(fromPath);
      deleteIndexedPath(toPath);
      rmSync(isolatedVault, { recursive: true, force: true });
    }
  });

  it('uses the evidence-backed max(5, 2%) prune limit', () => {
    assert.strictEqual(pruneLimit(0), 5);
    assert.strictEqual(pruneLimit(250), 5);
    assert.strictEqual(pruneLimit(251), 5);
    assert.strictEqual(pruneLimit(299), 5);
    assert.strictEqual(pruneLimit(300), 6);
    assert.strictEqual(evaluatePruneSafety({
      existingCount: 300, scannedCount: 294, missingCount: 6,
    }).allowed, true);
    assert.strictEqual(evaluatePruneSafety({
      existingCount: 300, scannedCount: 293, missingCount: 7,
    }).allowed, false);
    assert.strictEqual(evaluatePruneSafety({
      existingCount: 1, scannedCount: 0, missingCount: 1,
    }).allowed, false, 'zero-file scans refuse even below the absolute prune limit');
    assert.strictEqual(evaluatePruneSafety({
      existingCount: 0, scannedCount: 0, missingCount: 0,
    }).allowed, true, 'a fresh empty database may index an explicitly empty vault');
  });

  it('accepts only a positive safe integer for the exact prune confirmation', () => {
    assert.deepStrictEqual(parseVaultReindexArgs([]), { confirmPrune: null });
    assert.deepStrictEqual(parseVaultReindexArgs(['--confirm-prune=7']), { confirmPrune: 7 });
    assert.throws(() => parseVaultReindexArgs(['--confirm-prune=0']), /positive exact count/);
    assert.throws(() => parseVaultReindexArgs(['--confirm-prune=7.5']), /positive exact count/);
    assert.throws(() => parseVaultReindexArgs(['--confirm-prune=7e0']), /positive exact count/);
    assert.throws(() => parseVaultReindexArgs(['--confirm-prune=0x7']), /positive exact count/);
    assert.throws(() => parseVaultReindexArgs(['--confirm-prune=7=ignored']), /positive exact count/);
    assert.throws(
      () => parseVaultReindexArgs(['--confirm-prune=7', '--confirm-prune=8']),
      /only once/,
    );
    assert.throws(
      () => parseVaultReindexArgs([`--confirm-prune=${Number.MAX_SAFE_INTEGER + 1}`]),
      /positive exact count/,
    );
  });

  it('reproduces empty-root mass prune and refuses before changing any document', async () => {
    const emptyVault = mkdtempSync(join(tmpdir(), 'kb-empty-root-'));
    const prefix = 'empty-root';
    const database = getDb();
    const insertDocument = database.prepare(
      'INSERT INTO documents (title, content, source, doc_type) VALUES (?, ?, ?, ?)'
    );
    const insertVaultFile = database.prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, ?)'
    );
    database.transaction(() => {
      for (let index = 0; index < 12; index += 1) {
        const path = `${prefix}/${index}.md`;
        const doc = insertDocument.run(`Empty ${index}`, `original ${index}`, `vault:${path}`, 'note');
        insertVaultFile.run(path, `hash-${index}`, doc.lastInsertRowid, `Empty ${index}`, 'note');
      }
    })();

    try {
      await assert.rejects(
        indexVault(emptyVault),
        error => error instanceof VaultPruneRefusedError
          && error.code === 'KB_VAULT_PRUNE_REFUSED'
          && error.safety.missingCount === 12
          && error.safety.reason === 'zero_markdown_files',
      );
      assert.strictEqual(
        database.prepare(`SELECT COUNT(*) AS count FROM documents WHERE source LIKE 'vault:empty-root/%'`).get().count,
        12,
      );
      const warning = getHealth().warnings.find(item => item.includes('vault reindex refused'));
      assert.match(warning, /12\/12 missing paths \(zero_markdown_files\)/);
      const event = readFileSync(VAULT_INDEX_SAFETY_LOG, 'utf8').trim().split('\n').at(-1);
      assert.doesNotMatch(event, new RegExp(emptyVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(event, /Empty 0/);
    } finally {
      deleteIndexedPrefix('empty-root/%');
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('preserves ordinary small prune and rename workflows without an override', async () => {
    const normalVault = mkdtempSync(join(tmpdir(), 'kb-normal-prune-'));
    const folder = join(normalVault, 'normal');
    mkdirSync(folder);
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(folder, `${index}.md`), `# Normal ${index}\n\nbody ${index}`);
    }

    try {
      assert.strictEqual((await indexVault(normalVault)).indexed, 6);
      for (let index = 1; index < 6; index += 1) unlinkSync(join(folder, `${index}.md`));
      const pruned = await indexVault(normalVault);
      assert.strictEqual(pruned.deleted, 5);
      assert.strictEqual(
        getDb().prepare(
          "SELECT COUNT(*) AS count FROM vault_files WHERE vault_path LIKE 'normal/%' AND missing_at IS NULL"
        ).get().count,
        1,
      );

      const originalId = getDb().prepare(
        "SELECT document_id FROM vault_files WHERE vault_path = 'normal/0.md'"
      ).get().document_id;
      renameSync(join(folder, '0.md'), join(folder, 'renamed.md'));
      const renamed = await indexVault(normalVault);
      assert.deepStrictEqual(
        { indexed: renamed.indexed, deleted: renamed.deleted },
        { indexed: 1, deleted: 0 },
      );
      assert.strictEqual(
        getDb().prepare(
          "SELECT document_id FROM vault_files WHERE vault_path = 'normal/renamed.md'"
        ).get().document_id,
        originalId,
      );
    } finally {
      deleteIndexedPrefix('normal/%');
      rmSync(normalVault, { recursive: true, force: true });
    }
  });

  it('blocks a non-empty over-limit scan before edits, then accepts only the exact audited count', async () => {
    const guardedVault = mkdtempSync(join(tmpdir(), 'kb-guarded-prune-'));
    const folder = join(guardedVault, 'mass');
    mkdirSync(folder);
    const database = getDb();
    const insertDocument = database.prepare(
      'INSERT INTO documents (title, content, source, doc_type, file_path) VALUES (?, ?, ?, ?, ?)'
    );
    const insertVaultFile = database.prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, ?)'
    );
    database.transaction(() => {
      for (let index = 0; index < 300; index += 1) {
        const relPath = `mass/${index}.md`;
        const fullPath = join(guardedVault, relPath);
        writeFileSync(fullPath, `# Note ${index}\n\noriginal ${index}`);
        const doc = insertDocument.run(`Note ${index}`, `original ${index}`, `vault:${relPath}`, 'note', fullPath);
        insertVaultFile.run(relPath, `old-hash-${index}`, doc.lastInsertRowid, `Note ${index}`, 'note');
      }
    })();
    writeFileSync(join(folder, '0.md'), '# Note 0\n\nedited before guarded scan');
    for (let index = 293; index < 300; index += 1) unlinkSync(join(folder, `${index}.md`));

    try {
      const started = performance.now();
      await assert.rejects(
        indexVault(guardedVault),
        error => error instanceof VaultPruneRefusedError
          && error.safety.missingCount === 7
          && error.safety.limit === 6,
      );
      assert.ok(performance.now() - started < 5000, '300-path refusal should remain a bounded scan');
      assert.strictEqual(
        database.prepare("SELECT content FROM documents WHERE source = 'vault:mass/0.md'").get().content,
        'original 0',
        'the changed file must not be applied before the prune guard',
      );
      await assert.rejects(indexVault(guardedVault, { confirmPrune: 8 }), VaultPruneRefusedError);

      const result = await indexVault(guardedVault, { confirmPrune: 7 });
      assert.strictEqual(result.deleted, 7);
      assert.match(
        database.prepare("SELECT content FROM documents WHERE source = 'vault:mass/0.md'").get().content,
        /edited before guarded scan/,
      );
      assert.strictEqual(
        getHealth().warnings.find(item => item.includes('vault reindex refused')),
        undefined,
      );
      const events = readFileSync(VAULT_INDEX_SAFETY_LOG, 'utf8').trim().split('\n')
        .slice(-3).map(line => JSON.parse(line).event);
      assert.deepEqual(events, ['prune_refused', 'prune_refused', 'prune_override']);
    } finally {
      deleteIndexedPrefix('mass/%');
      rmSync(guardedVault, { recursive: true, force: true });
    }
  });
});
