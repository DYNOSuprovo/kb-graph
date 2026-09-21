import './helpers/tmp-kb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertDocument } from '../src/db.js';
import { storeEmbedding } from '../src/embeddings/embed.js';
import { semanticSearch, similarDocs } from '../src/embeddings/search.js';

test('semantic recall excludes detached documents even when a stale embedding exists', async () => {
  const content = 'semantic lifecycle sentinel content';
  const documentId = insertDocument({
    title: 'Semantic lifecycle sentinel',
    content,
    doc_type: 'note',
  }).id;

  try {
    assert.equal(await storeEmbedding(documentId, content), 1);
    getDb().prepare(`
      UPDATE documents
      SET detached_at = datetime('now'), detached_reason = 'vault_missing'
      WHERE id = ?
    `).run(documentId);

    const semantic = await semanticSearch(content, { includeSuperseded: true });
    const similar = await similarDocs(content, { includeSuperseded: true });
    assert.ok(!semantic.some(row => row.document_id === documentId));
    assert.ok(!similar.some(row => row.document_id === documentId));
  } finally {
    getDb().prepare('DELETE FROM embeddings WHERE document_id = ?').run(documentId);
    getDb().prepare('UPDATE documents SET source = NULL WHERE id = ?').run(documentId);
    getDb().prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  }
});
