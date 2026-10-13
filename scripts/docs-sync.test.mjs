// docs/RECOVERY.md must contain the exact recovery SQL that the recovery test runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every SQL block marked with a file in RECOVERY.md matches that file exactly', () => {
  const doc = readFileSync('docs/RECOVERY.md', 'utf8');
  const blocks = [...doc.matchAll(/<!-- file: (\S+) -->\n```sql\n([\s\S]*?)```/g)];
  assert.deepEqual(
    blocks.map((m) => m[1]),
    ['supabase/recovery/look_first.sql', 'supabase/recovery/restore_from_safety_log.sql'],
  );
  for (const [, file, body] of blocks) assert.equal(body, readFileSync(file, 'utf8'), file);
});
