import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { indexVault } from '../vault/indexer.js';
import {
  DETACHED_PURGE_BATCH_SIZE,
  detachedDocumentBatch,
  detachedDocumentPurgeScope,
  purgeDetachedDocumentBatch,
  setMeta,
} from '../db.js';
import { LOGS_DIR } from '../paths.js';
import { UsageError } from './flags.js';

const USAGE = 'Usage: kb vault reindex [--no-embeddings] [--confirm-prune=<exact-count>]';
const PURGE_USAGE = 'Usage: kb vault purge-detached [--grace-days=<days>] [--apply --preview-token=<token> --confirm-purge=<exact-count>]';
const DEFAULT_PURGE_GRACE_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;
const PURGE_AUDIT_EVENT = Object.freeze({
  CONFIRMATION_REFUSED: 'confirmation_refused',
  PREVIEWED: 'purge_previewed',
  APPLIED: 'purge_applied',
});
export const VAULT_PURGE_AUDIT_LOG = join(LOGS_DIR, 'vault-purge-audit.jsonl');

export function parseVaultReindexArgs(args) {
  const unexpected = args.filter(
    arg => arg !== '--no-embeddings' && !arg.startsWith('--confirm-prune='),
  );
  if (unexpected.length) throw new UsageError(`Unexpected reindex option: ${unexpected[0]}`, USAGE);
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
  console.log(`Done: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.detached} detached${preserved}${embedded}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.log(`  ${e}`));
  }
}

function integerFlag(args, name, fallback, { allowZero = false } = {}) {
  const prefix = `${name}=`;
  const values = args.filter(arg => arg.startsWith(prefix));
  if (values.length > 1) throw new UsageError(`${name} may be supplied only once`, PURGE_USAGE);
  if (values.length === 0) return fallback;
  const raw = values[0].slice(prefix.length);
  const pattern = allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  const value = Number(raw);
  if (!pattern.test(raw) || !Number.isSafeInteger(value)) {
    const kind = allowZero ? 'non-negative' : 'positive';
    throw new UsageError(`${name} must be a ${kind} safe integer, got: ${raw}`, PURGE_USAGE);
  }
  return value;
}

export function parseDetachedPurgeArgs(args, { now = Date.now() } = {}) {
  const unexpected = args.filter(
    arg => arg !== '--apply'
      && !arg.startsWith('--grace-days=')
      && !arg.startsWith('--confirm-purge=')
      && !arg.startsWith('--preview-token='),
  );
  if (unexpected.length) throw new UsageError(`Unexpected purge option: ${unexpected[0]}`, PURGE_USAGE);
  const apply = args.includes('--apply');
  const graceDays = integerFlag(args, '--grace-days', DEFAULT_PURGE_GRACE_DAYS);
  const confirmPurge = integerFlag(args, '--confirm-purge', null, { allowZero: true });
  const previewTokens = args.filter(arg => arg.startsWith('--preview-token='));
  if (previewTokens.length > 1) {
    throw new UsageError('--preview-token may be supplied only once', PURGE_USAGE);
  }
  const previewToken = previewTokens[0]?.slice('--preview-token='.length) || null;
  if (
    previewToken
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewToken)
  ) {
    throw new UsageError('--preview-token must be the UUID from a prior dry run', PURGE_USAGE);
  }
  if (apply && (confirmPurge === null || previewToken === null)) {
    throw new UsageError(
      '--apply requires --preview-token=<token> and --confirm-purge=<exact-count>',
      PURGE_USAGE,
    );
  }
  if (!apply && (confirmPurge !== null || previewToken !== null)) {
    throw new UsageError('--preview-token and --confirm-purge require --apply', PURGE_USAGE);
  }
  return {
    apply,
    graceDays,
    confirmPurge,
    previewToken,
    before: new Date(now - graceDays * MILLISECONDS_PER_DAY).toISOString(),
  };
}

function recordPurgeAudit(details) {
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(
    VAULT_PURGE_AUDIT_LOG,
    `${JSON.stringify({ ts: new Date().toISOString(), ...details, pid: process.pid })}\n`,
    { mode: 0o600 },
  );
  chmodSync(VAULT_PURGE_AUDIT_LOG, 0o600);
}

function readPurgePreview(token) {
  let lines;
  try {
    lines = readFileSync(VAULT_PURGE_AUDIT_LOG, 'utf8').trim().split('\n');
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.event === PURGE_AUDIT_EVENT.PREVIEWED && event.preview_token === token) {
        return event;
      }
    } catch {
      // A complete matching preview is required; ignore corrupt audit lines.
    }
  }
  return null;
}

export function vaultPurgeDetached(args = []) {
  const options = parseDetachedPurgeArgs(args);
  if (!options.apply) {
    const scope = detachedDocumentPurgeScope(options.before);
    const report = {
      event: PURGE_AUDIT_EVENT.PREVIEWED,
      applied: false,
      grace_days: options.graceDays,
      eligible: scope.eligible,
      before: options.before,
      preview_token: randomUUID(),
    };
    recordPurgeAudit({ ...report, scope_max_id: scope.max_id });
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const preview = readPurgePreview(options.previewToken);
  if (!preview || preview.grace_days !== options.graceDays) {
    throw new UsageError('no matching audited purge preview; run the dry run again', PURGE_USAGE);
  }
  const scope = detachedDocumentPurgeScope(preview.before);
  if (scope.eligible !== preview.eligible || scope.max_id !== preview.scope_max_id) {
    throw new UsageError('eligible detached rows changed since preview; run the dry run again', PURGE_USAGE);
  }
  if (options.confirmPurge !== scope.eligible) {
    recordPurgeAudit({
      event: PURGE_AUDIT_EVENT.CONFIRMATION_REFUSED,
      applied: false,
      grace_days: options.graceDays,
      eligible: scope.eligible,
      confirmed: options.confirmPurge,
      before: preview.before,
      preview_token: options.previewToken,
    });
    throw new UsageError(
      `--confirm-purge must equal the current eligible count (${scope.eligible}), got: ${options.confirmPurge}`,
      PURGE_USAGE,
    );
  }

  let purged = 0;
  let afterId = 0;
  while (afterId < scope.max_id) {
    const ids = detachedDocumentBatch({
      before: preview.before,
      afterId,
      maxId: scope.max_id,
      limit: DETACHED_PURGE_BATCH_SIZE,
    });
    if (ids.length === 0) break;
    afterId = ids.at(-1);
    purged += purgeDetachedDocumentBatch(ids, { before: preview.before });
  }
  const report = {
    event: PURGE_AUDIT_EVENT.APPLIED,
    applied: true,
    grace_days: options.graceDays,
    eligible: scope.eligible,
    purged,
    skipped_after_revalidation: scope.eligible - purged,
    before: preview.before,
    preview_token: options.previewToken,
  };
  recordPurgeAudit(report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}
