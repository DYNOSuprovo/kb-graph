import { indexVault } from '../vault/indexer.js';
import { setMeta } from '../db.js';
import { UsageError } from './flags.js';

const USAGE = 'Usage: kb vault reindex [--no-embeddings] [--confirm-prune=<exact-count>]';

export function parseVaultReindexArgs(args) {
  const confirmations = args.filter(arg => arg.startsWith('--confirm-prune='));
  if (confirmations.length === 0) return { confirmPrune: null };
  if (confirmations.length > 1) {
    throw new UsageError('--confirm-prune may be supplied only once', USAGE);
  }
  const raw = confirmations[0].slice('--confirm-prune='.length);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UsageError(`--confirm-prune must be a positive exact count, got: ${raw}`, USAGE);
  }
  const confirmPrune = Number(raw);
  if (!Number.isSafeInteger(confirmPrune)) {
    throw new UsageError(`--confirm-prune must be a positive exact count, got: ${raw}`, USAGE);
  }
  return { confirmPrune };
}

export async function vaultReindex(args = []) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    console.error('Error: OBSIDIAN_VAULT_PATH not set');
    process.exit(1);
  }
  const withEmbeddings = !args.includes('--no-embeddings');
  const { confirmPrune } = parseVaultReindexArgs(args);
  console.log(`Indexing vault at ${vaultPath}...${withEmbeddings ? ' (with embeddings)' : ''}`);
  const result = await indexVault(vaultPath, { embeddings: withEmbeddings, confirmPrune });
  setMeta(
    'last_reindex',
    `${result.indexed} indexed, ${result.skipped} unchanged, ${result.errors.length} errors`
      + (result.preserved ? `, ${result.preserved} concurrent writes preserved` : ''),
  );
  const preserved = result.preserved ? `, ${result.preserved} concurrent write preserved` : '';
  const embedded = result.embedded ? `, ${result.embedded} embedded` : '';
  console.log(`Done: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.deleted} removed${preserved}${embedded}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`  ${e}`));
  }
}
