import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  GOLDEN_ENV_FLAGS,
  assertGenerationGuards,
  isDirectRun,
  readGenerationDirtyStatus,
} from '../scripts/generate-cri-golden-baseline.mts';

// Unit coverage for the generator CLI's guard logic (issue #7728 review
// follow-up): the ancestry and dirtiness gates are pure functions over
// injected git results, and the main-guard isDirectRun must survive both
// direct and symlinked invocation paths. Also pins the env-read exhaustiveness
// claim: every RESILIENCE_* env read in the resilience scorer tree must be
// either one of the pinned dynamic flags or the known module-load const.

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');
const SCORER_TREE_DIR = path.join(REPO_ROOT, 'server/worldmonitor/resilience/v1');
const MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts')).href;

function guardsFixture(overrides: Partial<Parameters<typeof assertGenerationGuards>[0]> = {}) {
  return {
    headSha: 'a'.repeat(40),
    headIsAncestorOfOriginMain: true,
    dirtyStatusLines: [],
    allowNonMain: false,
    allowDirtyTree: false,
    ...overrides,
  };
}

describe('CRI golden baseline generator guards', () => {
  describe('assertGenerationGuards', () => {
    it('accepts an ancestor commit on a clean tree', () => {
      assert.doesNotThrow(() => assertGenerationGuards(guardsFixture()));
    });

    it('refuses a non-ancestor or unprovable commit without --allow-non-main', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false })),
        /--allow-non-main/,
      );
    });

    it('accepts a non-ancestor commit only with --allow-non-main', () => {
      assert.doesNotThrow(() =>
        assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false, allowNonMain: true })),
      );
    });

    it('refuses guarded dirty paths without --allow-dirty-fixture', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: [' M server/worldmonitor/resilience/v1/_shared.ts'] })),
        /--allow-dirty-fixture/,
      );
    });

    it('accepts dirty guarded paths only with --allow-dirty-fixture', () => {
      assert.doesNotThrow(() =>
        assertGenerationGuards(guardsFixture({
          dirtyStatusLines: [' M tests/fixtures/resilience-whole-index-pairs-2026-08-13.json'],
          allowDirtyTree: true,
        })),
      );
    });

    it('fails closed when dirtiness cannot be determined', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: null })),
        /could not determine working-tree dirtiness/,
      );
    });

    it('keeps the two override flags independent', () => {
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ headIsAncestorOfOriginMain: false, allowDirtyTree: true })),
        /--allow-non-main/,
      );
      assert.throws(
        () => assertGenerationGuards(guardsFixture({ dirtyStatusLines: ['?? x'], allowNonMain: true })),
        /--allow-dirty-fixture/,
      );
    });
  });

  describe('working-tree input guard', () => {
    it('rejects real staged, unstaged, and untracked inputs while allowing output-only changes', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wm-golden-inputs-'));
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
      const write = (file: string, content: string) => {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      const dependencies = [
        'server/_shared/resilience-stats.ts',
        'server/_shared/resilience-freshness.ts',
        'shared/iso2-to-iso3.json',
        'tsconfig.json',
      ];
      const output = 'tests/fixtures/resilience-cri-golden-baseline-2026-08-13.json';
      try {
        git('init', '--quiet');
        for (const file of [...dependencies, output]) write(file, '{}\n');
        git('add', '.');
        git('-c', 'user.name=Guard test', '-c', 'user.email=guard@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Input baseline');
        assert.deepEqual(readGenerationDirtyStatus(dir), []);
        write(output, '{"regenerated":true}\n');
        assert.deepEqual(readGenerationDirtyStatus(dir), []);
        git('add', output);
        assert.deepEqual(readGenerationDirtyStatus(dir), []);

        for (const file of dependencies) {
          write(file, '{"changed":true}\n');
          for (const staged of [false, true]) {
            if (staged) git('add', file);
            const dirtyStatusLines = readGenerationDirtyStatus(dir);
            assert.ok(dirtyStatusLines?.some((line) => line.endsWith(file)), file);
            assert.throws(() => assertGenerationGuards(guardsFixture({ dirtyStatusLines })), /--allow-dirty-fixture/);
          }
          write(file, '{}\n');
          git('add', file);
        }
        write('shared/new-scoring-input.json', '{}\n');
        const dirtyStatusLines = readGenerationDirtyStatus(dir);
        assert.ok(dirtyStatusLines?.some((line) => line === '?? shared/new-scoring-input.json'));
        assert.throws(() => assertGenerationGuards(guardsFixture({ dirtyStatusLines })), /--allow-dirty-fixture/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isDirectRun', () => {
    it('is true for the direct script path', () => {
      assert.equal(isDirectRun(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts'), MODULE_URL), true);
    });

    it('is false when the module is imported by another file', () => {
      assert.equal(isDirectRun(path.join(TESTS_ROOT, 'cri-golden-baseline-guards.test.mts'), MODULE_URL), false);
    });

    it('is true through a symlinked script path (macOS /tmp -> /private/tmp style)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wm-golden-guard-'));
      try {
        const link = path.join(dir, 'linked-generator.mts');
        symlinkSync(path.join(REPO_ROOT, 'scripts/generate-cri-golden-baseline.mts'), link);
        assert.equal(isDirectRun(link, MODULE_URL), true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is false when argv1 is missing', () => {
      assert.equal(isDirectRun(undefined, MODULE_URL), false);
    });
  });

  describe('env-read exhaustiveness', () => {
    // The frozen harness pins exactly the four dynamic RESILIENCE_* env reads;
    // RESILIENCE_SCHEMA_V2_ENABLED is the one known module-load read, guarded
    // separately by assertFrozenScorerDefaults(). If a new RESILIENCE_* env
    // read appears in the scorer tree, the golden bytes' env sensitivity is no
    // longer pinned — add it to GOLDEN_ENV_FLAGS (dynamic reads) or to the
    // module-load guard here, then regenerate the baseline.
    const KNOWN_MODULE_LOAD_READS = new Set(['RESILIENCE_SCHEMA_V2_ENABLED']);

    it('keeps every RESILIENCE_* env read in the scorer tree accounted for', () => {
      const unexpected: string[] = [];
      for (const entry of readdirSync(SCORER_TREE_DIR, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const filePath = path.join(entry.parentPath, entry.name);
        const source = readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(/process\.env\.(RESILIENCE_[A-Z_0-9]+)/g)) {
          const name = match[1];
          if (!(name in GOLDEN_ENV_FLAGS) && !KNOWN_MODULE_LOAD_READS.has(name)) {
            unexpected.push(`${name} (${path.relative(REPO_ROOT, filePath)})`);
          }
        }
      }
      assert.deepEqual(
        unexpected,
        [],
        'unaccounted RESILIENCE_* env reads in the scorer tree: ' +
          `${unexpected.join('; ')}. Dynamic reads must be pinned in GOLDEN_ENV_FLAGS and ` +
          'module-load reads guarded by assertFrozenScorerDefaults(), then regenerate the baseline.',
      );
    });
  });
});
