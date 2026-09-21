import { indexVault } from '../../src/vault/indexer.js';

const result = await indexVault(process.argv[2], { embeddings: false });
process.stdout.write(JSON.stringify(result));
