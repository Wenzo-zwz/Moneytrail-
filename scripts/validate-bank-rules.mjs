// Node 24 runs this shared TypeScript validator without a dependency or separate copy.
import { readFile } from 'node:fs/promises';
import { validateBankRuleManifest } from '../src/lib/bankRulesValidation.ts';

try {
  if (!process.argv[2]) throw new Error('Expected the canonical rules manifest path');
  const rule = validateBankRuleManifest(JSON.parse(await readFile(process.argv[2], 'utf8')));
  if (process.argv[3]) {
    const previous = validateBankRuleManifest(JSON.parse(await readFile(process.argv[3], 'utf8')));
    if (rule.version < previous.version || (rule.version === previous.version && JSON.stringify(rule) !== JSON.stringify(previous))) {
      throw new Error('Changed rules require a version greater than the last published manifest.');
    }
  }
  console.log(`Bank rules version ${rule.version} passed schema and fixed regression checks (not an Apple runtime test).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
