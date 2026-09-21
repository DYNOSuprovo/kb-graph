import './helpers/tmp-kb.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { createSession } from '../src/auth.js';
import { getDb } from '../src/db.js';
import apiRouter from '../src/routes/api.js';
import { indexVault } from '../src/vault/indexer.js';

async function withServer(run) {
  const app = express();
  app.use(apiRouter);
  const socketPath = join(tmpdir(), `kb-reindex-test-${randomBytes(8).toString('hex')}.sock`);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(socketPath);
    listener.once('listening', () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(socketPath, { force: true });
  }
}

function postReindex(socketPath) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method: 'POST',
      path: '/api/vault/reindex',
      headers: { Cookie: `kb_session=${createSession()}` },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('post-sync vault reindex', () => {
  it('replaces an edited note and its semantic vector together', async () => {
    const vault = process.env.OBSIDIAN_VAULT_PATH;
    const directory = join(vault, 'inbox');
    const path = join(directory, 'post-sync-edit.md');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, '---\ntitle: Post-sync edit\n---\n\nOriginal semantic body.');
    await indexVault(vault, { embeddings: true });

    writeFileSync(path, '---\ntitle: Post-sync edit\n---\n\nReplacement semantic body.');
    await withServer(async socketPath => {
      assert.equal((await postReindex(socketPath)).status, 200);
    });

    const doc = getDb().prepare("SELECT id, content FROM documents WHERE title = 'Post-sync edit'").get();
    const embedding = getDb().prepare(
      'SELECT chunk_text FROM embeddings WHERE document_id = ? ORDER BY chunk_index LIMIT 1',
    ).get(doc.id);
    assert.equal(doc.content, 'Replacement semantic body.');
    assert.match(embedding.chunk_text, /Replacement semantic body/);
    assert.doesNotMatch(embedding.chunk_text, /Original semantic body/);
  });

  it('returns a privacy-safe conflict when the prune guard refuses', async () => {
    const database = getDb();
    const insertDocument = database.prepare(
      'INSERT INTO documents (title, content, source, doc_type) VALUES (?, ?, ?, ?)'
    );
    const insertVaultFile = database.prepare(
      'INSERT INTO vault_files (vault_path, content_hash, document_id, title, note_type) VALUES (?, ?, ?, ?, ?)'
    );
    database.transaction(() => {
      for (let index = 0; index < 6; index += 1) {
        const vaultPath = `missing-route/${index}.md`;
        const document = insertDocument.run(
          `Route secret ${index}`, `private route body ${index}`, `vault:${vaultPath}`, 'note'
        );
        insertVaultFile.run(vaultPath, `missing-${index}`, document.lastInsertRowid, `Route secret ${index}`, 'note');
      }
    })();

    try {
      await withServer(async socketPath => {
        const response = await postReindex(socketPath);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'KB_VAULT_PRUNE_REFUSED');
        assert.equal(response.body.missing_count, 6);
        assert.equal(response.body.limit, 5);
        assert.doesNotMatch(JSON.stringify(response.body), /missing-route|Route secret|private route body/);
      });
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM documents WHERE source LIKE 'vault:missing-route/%'").get().count,
        6,
      );
    } finally {
      database.prepare("DELETE FROM vault_files WHERE vault_path LIKE 'missing-route/%'").run();
      database.prepare("DELETE FROM documents WHERE source LIKE 'vault:missing-route/%'").run();
    }
  });
});
