import './helpers/tmp-kb.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { getDb } from '../src/db.js';
import {
  parseDetachedPurgeArgs,
  VAULT_PURGE_AUDIT_LOG,
  vaultPurgeDetached,
} from '../src/cli/vault-cli.js';

afterEach(() => rmSync(VAULT_PURGE_AUDIT_LOG, { force: true }));

describe('detached document purge', () => {
  it('is dry by default and requires an exact apply confirmation', () => {
    const fixedNow = Date.parse('2026-09-21T12:00:00.000Z');
    assert.deepStrictEqual(parseDetachedPurgeArgs([], { now: fixedNow }), {
      apply: false,
      graceDays: 30,
      confirmPurge: null,
      previewToken: null,
      before: '2026-08-22T12:00:00.000Z',
    });
    assert.throws(() => parseDetachedPurgeArgs(['--apply']), /requires --preview-token/);
    assert.throws(
      () => parseDetachedPurgeArgs(['--confirm-purge=1']),
      /require --apply/,
    );
    assert.throws(
      () => parseDetachedPurgeArgs(['--apply', '--confirm-purge=1.5']),
      /non-negative safe integer/,
    );
    assert.throws(
      () => parseDetachedPurgeArgs(['--no-embeddings']),
      /Unexpected purge option/,
    );
  });

  it('tombstones only after an exact confirmed grace-period apply', () => {
    const db = getDb();
    const docId = Number(db.prepare(`
      INSERT INTO documents (
        title, content, source, doc_type, detached_at, detached_reason
      ) VALUES (
        'Purge privacy sentinel',
        'must never appear in the audit log',
        'vault:private/sentinel.md',
        'note',
        '2000-01-01 00:00:00',
        'vault_missing'
      )
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO vault_files (
        vault_path, content_hash, document_id, title, note_type, missing_at
      ) VALUES (
        'private/sentinel.md',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ?,
        'Purge privacy sentinel',
        'note',
        '2000-01-01 00:00:00'
      )
    `).run(docId);
    const retrievalId = Number(db.prepare(`
      INSERT INTO retrievals (doc_id, surface, session, doc_version)
      VALUES (?, 'kb_read', 'purge-proof', 'v1')
    `).run(docId).lastInsertRowid);
    db.prepare(`
      INSERT INTO write_decisions (threshold, refused, doc_id)
      VALUES (0.85, 0, ?)
    `).run(docId);
    db.prepare(`
      INSERT INTO retrieval_outcomes (
        retrieval_id, doc_id, doc_version, session, outcome,
        evidence_kind, evidence_ref, source
      ) VALUES (?, ?, 'v1', 'purge-proof', 'helped', 'test', 'proof', 'test')
    `).run(retrievalId, docId);

    const dryRun = vaultPurgeDetached(['--grace-days=30']);
    assert.strictEqual(dryRun.applied, false);
    assert.strictEqual(dryRun.eligible, 1);
    assert.ok(db.prepare('SELECT 1 FROM documents WHERE id = ?').get(docId));
    assert.throws(
      () => vaultPurgeDetached([
        '--grace-days=30',
        '--apply',
        `--preview-token=${dryRun.preview_token}`,
        '--confirm-purge=2',
      ]),
      /current eligible count \(1\)/,
    );

    const applied = vaultPurgeDetached([
      '--grace-days=30',
      '--apply',
      `--preview-token=${dryRun.preview_token}`,
      '--confirm-purge=1',
    ]);
    assert.strictEqual(applied.purged, 1);
    assert.strictEqual(applied.skipped_after_revalidation, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM documents WHERE id = ?').get(docId).count, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM vault_files WHERE document_id = ?').get(docId).count, 0);
    assert.deepStrictEqual(
      db.prepare(`
        SELECT document_id, vault_path, content_hash, reason
        FROM document_tombstones WHERE document_id = ?
      `).get(docId),
      {
        document_id: docId,
        vault_path: 'private/sentinel.md',
        content_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        reason: 'detached_grace_expired',
      },
    );
    assert.strictEqual(db.prepare('SELECT doc_id FROM retrievals WHERE id = ?').get(retrievalId).doc_id, null);
    assert.strictEqual(db.prepare('SELECT doc_id FROM write_decisions').get().doc_id, null);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM retrieval_outcomes').get().count, 0);
    const repeatedPreview = vaultPurgeDetached(['--grace-days=30']);
    const repeated = vaultPurgeDetached([
      '--grace-days=30',
      '--apply',
      `--preview-token=${repeatedPreview.preview_token}`,
      '--confirm-purge=0',
    ]);
    assert.strictEqual(repeated.purged, 0);
    assert.strictEqual(
      db.prepare(
        'SELECT COUNT(*) AS count FROM document_tombstones WHERE document_id = ?'
      ).get(docId).count,
      1,
    );

    const audit = readFileSync(VAULT_PURGE_AUDIT_LOG, 'utf8');
    assert.doesNotMatch(audit, /private\/sentinel|Purge privacy|must never/);
    assert.match(audit, /"event":"confirmation_refused"/);
    assert.match(audit, /"purged":1/);
  });
});
