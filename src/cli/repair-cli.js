import {
  applyIdentityRepair,
  DEFAULT_IDENTITY_REPAIR_BATCH_SIZE,
  MAX_IDENTITY_REPAIR_BATCH_SIZE,
  planIdentityRepair,
  publicIdentityRepairReport,
  undoIdentityRepair,
} from '../identity-repair.js';
import { UsageError } from './flags.js';

const USAGE = 'Usage: kb repair identity --backup=<immutable-db> --report=<owner-only-json> [--apply --confirm=<plan-hash> | --undo=<run-id> --confirm=<run-id>] [--batch-size=<count>]';

function singleValue(args, name, { required = false } = {}) {
  const prefix = `${name}=`;
  const values = args.filter(arg => arg.startsWith(prefix));
  if (values.length > 1) throw new UsageError(`${name} may be supplied only once`, USAGE);
  const value = values[0]?.slice(prefix.length) || null;
  if (required && !value) throw new UsageError(`${name} is required`, USAGE);
  return value;
}

function parseBatchSize(rawBatchSize) {
  if (rawBatchSize == null) return DEFAULT_IDENTITY_REPAIR_BATCH_SIZE;
  const batchSize = Number(rawBatchSize);
  if (
    !/^[1-9][0-9]*$/.test(rawBatchSize)
    || !Number.isSafeInteger(batchSize)
    || batchSize > MAX_IDENTITY_REPAIR_BATCH_SIZE
  ) {
    throw new UsageError(
      `--batch-size must be between 1 and ${MAX_IDENTITY_REPAIR_BATCH_SIZE}`,
      USAGE,
    );
  }
  return batchSize;
}

export function parseIdentityRepairArgs(args) {
  if (args[0] !== 'identity') {
    throw new UsageError('repair supports only the identity subcommand', USAGE);
  }
  const options = args.slice(1);
  const unexpected = options.filter(
    arg => arg !== '--apply'
      && !arg.startsWith('--backup=')
      && !arg.startsWith('--report=')
      && !arg.startsWith('--confirm=')
      && !arg.startsWith('--undo=')
      && !arg.startsWith('--batch-size='),
  );
  if (unexpected.length > 0) {
    throw new UsageError(`Unexpected repair option: ${unexpected[0]}`, USAGE);
  }
  const apply = options.includes('--apply');
  if (options.filter(arg => arg === '--apply').length > 1) {
    throw new UsageError('--apply may be supplied only once', USAGE);
  }
  const backupPath = singleValue(options, '--backup', { required: true });
  const reportPath = singleValue(options, '--report', { required: true });
  const confirm = singleValue(options, '--confirm');
  const undoRunId = singleValue(options, '--undo');
  const batchSize = parseBatchSize(singleValue(options, '--batch-size'));
  if (apply && undoRunId) {
    throw new UsageError('--apply and --undo cannot be used together', USAGE);
  }
  if ((apply || undoRunId) && !confirm) {
    throw new UsageError('--confirm is required for apply and undo', USAGE);
  }
  if (!apply && !undoRunId && confirm) {
    throw new UsageError('--confirm is only valid with --apply or --undo', USAGE);
  }
  return { apply, backupPath, batchSize, confirm, reportPath, undoRunId };
}

export async function runRepairCli(args = []) {
  const options = parseIdentityRepairArgs(args);
  if (options.apply) {
    const result = await applyIdentityRepair(options);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (options.undoRunId) {
    if (options.confirm !== options.undoRunId) {
      throw new UsageError('--confirm must equal --undo=<run-id>', USAGE);
    }
    const result = await undoIdentityRepair(options);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const report = await planIdentityRepair(options);
  const output = publicIdentityRepairReport(report);
  console.log(JSON.stringify(output, null, 2));
  return output;
}
