import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBED_MODEL_FILE_NAME } from '../../electron/main/search/embed-model-source';

// Drift tests for the M4-1b embedder model-publish tooling (ADR-0029): the
// workflow_dispatch-only publish-embed-model workflow, the convert-embed-model.sh
// conversion script (with the non-obvious SentencePiece/t5 tokenizer fix), and the
// finalized release tag in embed-model-source.ts. These pin the load-bearing
// invariants — the human-required release-environment gate, least-privilege
// permissions, the SAME pinned llama.cpp commit as the engine build, the
// `tokenizer.ggml.model == t5` guard (a wrong tokenizer = broken embeddings), and the
// SHA-pinned actions — so they can never silently regress. All reads are
// CRLF-normalized so the assertions hold on a Windows (CRLF) checkout too.
const repoRoot = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** Read a repo file CRLF-normalized (Windows-checkout safe); '' if it does not exist. */
function readIfExists(rel: string): string {
  const path = repoRoot(rel);
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
}

const publishYml = readIfExists('.github/workflows/publish-embed-model.yml');
const convertScript = readIfExists('scripts/convert-embed-model.sh');
const descriptor = readIfExists('electron/main/search/embed-model-source.ts');
const embedBuildScript = readIfExists('scripts/build-embed-cli.sh');
const releaseYml = readIfExists('.github/workflows/release.yml');
const ciYml = readIfExists('.github/workflows/ci.yml');

// The single pinned llama.cpp commit — single source of truth shared with
// scripts/build-embed-cli.sh and ci.yml's embed-cli job.
const LLAMA_CPP_COMMIT = '931eb37f8cac5a6ca84d5641445d460af2a9d7dd';

/** Body lines of a top-level 2-space-indented `jobs:` entry, by id (CRLF-safe). */
function jobBlock(yaml: string, jobId: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  if (start === -1) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && /^ {0,2}\S/.test(line)) break; // next job or top-level key
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Parse the first `permissions:` block in a YAML section into a key→value record.
 * Handles any indent level (top-level 0, job-level 4 spaces, etc.) by comparing
 * relative indentation — no YAML parser required.
 */
function parsePermissions(section: string): Record<string, string> {
  const lines = section.split('\n');
  const permIdx = lines.findIndex((l) => /^\s*permissions:\s*$/.test(l));
  if (permIdx === -1) return {};
  const permLine = lines[permIdx];
  const baseIndent = permLine.length - permLine.trimStart().length;
  const result: Record<string, string> = {};
  for (let i = permIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= baseIndent) break; // back to same or shallower indent → done
    const m = line.match(/^\s*([\w-]+):\s*(\S+)/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

/**
 * Parse the `permissions:` block anchored strictly to indent 0 (workflow-level only).
 * Returns null if the block is absent, in non-block scalar/inline-map form, or if the
 * first `permissions:` in the file is not at column 0 — never falls through to
 * job-level blocks.
 *
 * Stub — indent-0 anchor not yet enforced; demonstrates the fail-open (#277).
 */
function parseTopLevelPermissions(yaml: string): Record<string, string> | null {
  return parsePermissions(yaml); // stub: no indent-0 anchor → fail-open
}

describe('publish-embed-model workflow exists and is workflow_dispatch-only (M4-1b, ADR-0029)', () => {
  it('exists as its own workflow file', () => {
    expect(publishYml).not.toBe('');
  });

  it('runs ONLY on manual workflow_dispatch — never auto-runs on push/PR/schedule', () => {
    expect(publishYml).toMatch(/\non:\n {2}workflow_dispatch:/);
    expect(publishYml).not.toMatch(/^ {2}push:/m);
    expect(publishYml).not.toMatch(/^ {2}pull_request:/m);
    expect(publishYml).not.toMatch(/^ {2}schedule:/m);
  });

  it('serializes dispatches and never cancels an in-progress publish', () => {
    expect(publishYml).toMatch(/concurrency:/);
    expect(publishYml).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('publish-embed-model gates the upload behind the protected release environment', () => {
  const convert = jobBlock(publishYml, 'convert');
  const publish = jobBlock(publishYml, 'publish');

  it('uploads the asset from a job that runs in `environment: release` (human-required gate)', () => {
    expect(publish).toMatch(/^\s*environment:\s*release\s*$/m);
    // The required-reviewer gate guards exactly one job — the one that publishes.
    // Line-anchored so an `environment: release` mention in a comment isn't counted.
    expect(publishYml.match(/^\s*environment:\s*release\s*$/gm)).toHaveLength(1);
  });

  it('locks the FULL per-job permissions to the exact least-privilege set — any added scope fails (issue #234)', () => {
    // Top-level: read-only so jobs without an explicit block can never write by default.
    expect(parsePermissions(publishYml)).toEqual({ contents: 'read' });
    // convert job: read-only — conversion + quantization never needs a write scope.
    expect(parsePermissions(convert)).toEqual({ contents: 'read' });
    // publish job: EXACTLY contents:write — the one scope the upload step requires.
    // toEqual checks the FULL key set; id-token, packages, actions, … are all absent.
    expect(parsePermissions(publish)).toEqual({ contents: 'write' });
  });

  it('skips the upload (and the environment approval) on a dry run', () => {
    expect(publish).toMatch(/if:\s*\$\{\{\s*!inputs\.dry_run\s*\}\}/);
    expect(publishYml).toMatch(/dry_run:/);
  });

  it('publishes to the models-embed-v1 tag via a SHA-pinned softprops/action-gh-release', () => {
    expect(publish).toMatch(
      /uses:\s*softprops\/action-gh-release@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/,
    );
    expect(publishYml).toMatch(/RELEASE_TAG:\s*models-embed-v1\b/);
    expect(publish).toMatch(/tag_name:\s*\$\{\{\s*env\.RELEASE_TAG\s*\}\}/);
    // The one publisher creates exactly one release — no matrix fan-out.
    expect(publish).not.toMatch(/matrix:/);
  });
});

describe('publish-embed-model reuses the pinned llama.cpp commit + SHA-pins every action', () => {
  it('pins the SAME immutable llama.cpp commit as the embed-cli engine build', () => {
    expect(publishYml).toMatch(new RegExp(`LLAMA_CPP_COMMIT:\\s*${LLAMA_CPP_COMMIT}`));
    // Single source of truth: the engine build script pins the very same commit.
    expect(embedBuildScript).toContain(LLAMA_CPP_COMMIT);
  });

  it('SHA-pins every action to a 40-hex commit with a # vX.Y.Z comment', () => {
    const usesLines = publishYml.split('\n').filter((l) => /^\s*uses:/.test(l));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s*[^@\s]+@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+/);
    }
  });
});

describe('convert-embed-model.sh applies the SentencePiece (t5) fix and fails closed', () => {
  it('exists and runs under strict bash (set -euo pipefail)', () => {
    expect(convertScript).not.toBe('');
    expect(convertScript).toMatch(/set -euo pipefail/);
  });

  it('reuses the pinned llama.cpp commit for both convert + quantize (single source of truth)', () => {
    expect(convertScript).toContain(LLAMA_CPP_COMMIT);
  });

  it('patches BertModel.set_vocab to the XLM-RoBERTa SentencePiece path (not WordPiece)', () => {
    // The M4-0 spike fix: multilingual-e5 declares BertModel but uses an XLM-RoBERTa
    // SentencePiece tokenizer, so route set_vocab through _xlmroberta_set_vocab (which
    // emits tokenizer.ggml.model = t5) guarded on the sentencepiece model + tokenizer_class.
    expect(convertScript).toMatch(/def set_vocab/);
    expect(convertScript).toMatch(/_xlmroberta_set_vocab/);
    expect(convertScript).toMatch(/XLMRobertaTokenizer/);
    expect(convertScript).toMatch(/sentencepiece\.bpe\.model/);
    expect(convertScript).toMatch(/KAWSAY-PATCH/);
  });

  it('HARD-ASSERTS tokenizer.ggml.model == t5 and refuses to publish otherwise', () => {
    expect(convertScript).toMatch(/tokenizer\.ggml\.model/);
    expect(convertScript).toMatch(/!=\s*"t5"/);
    expect(convertScript).toMatch(/Refusing to publish/);
    // Quantizes to the Q4_K_M variant the descriptor filename encodes.
    expect(convertScript).toMatch(/Q4_K_M/);
  });

  it('emits the SHA-256 + byte size and the exact GGUF basename the descriptor pins', () => {
    expect(convertScript).toMatch(/EMBED_MODEL_SHA256=/);
    expect(convertScript).toMatch(/EMBED_MODEL_SIZE_BYTES=/);
    expect(convertScript).toContain(EMBED_MODEL_FILE_NAME);
    expect(publishYml).toContain(EMBED_MODEL_FILE_NAME);
  });
});

describe('embed-model-source.ts finalizes the release tag (no placeholder left)', () => {
  it('no longer carries the -PLACEHOLDER release tag', () => {
    expect(descriptor).not.toBe('');
    expect(descriptor).not.toMatch(/PLACEHOLDER/);
  });

  it('points the download URL at the final models-embed-v1 release tag', () => {
    expect(descriptor).toMatch(
      /releases\/download\/models-embed-v1\/multilingual-e5-small-q4_k_m\.gguf/,
    );
  });

  it('pins the FINALIZED SHA-256 + byte size — the post-publish TODO/sentinel is gone', () => {
    // publish-embed-model.yml has run: the descriptor no longer carries the
    // pre-publish TODO(post-publish) marker, and both integrity constants are pinned
    // to the real published `models-embed-v1` asset (not the all-zero fail-closed
    // sentinel that keeps isEmbedModelPublished() false).
    expect(descriptor).not.toMatch(/TODO\(post-publish\)/);
    // EMBED_MODEL_SHA256 is the exact 64-hex digest of the published GGUF...
    expect(descriptor).toMatch(
      /export const EMBED_MODEL_SHA256 =\s*'0539137155820094fc7e966e8ea97e94e1cd4b8cd3e0a4f4933abab63bfd6019'/,
    );
    // ...and never the all-zero sentinel.
    expect(descriptor).not.toMatch(/export const EMBED_MODEL_SHA256 =\s*'0{64}'/);
    // EMBED_MODEL_SIZE_BYTES is the concrete published byte count, not a 0/approx placeholder.
    expect(descriptor).toMatch(/export const EMBED_MODEL_SIZE_BYTES = 124_837_280;/);
  });
});

describe('publish-embed-model is additive — it does not weaken existing publish gates', () => {
  it('leaves release.yml gating its single publish job behind environment: release', () => {
    expect(releaseYml).toMatch(/environment:\s*release/);
    expect(releaseYml.match(/environment:\s*release/g)).toHaveLength(1);
  });

  it('leaves ci.yml building the embed-cli engine from the pinned source', () => {
    expect(ciYml).toMatch(/scripts\/build-embed-cli\.sh/);
    expect(ciYml).toContain(LLAMA_CPP_COMMIT);
  });
});

describe('parseTopLevelPermissions anchors to indent 0 — fail-open regression (#277)', () => {
  // Synthetic workflow YAML: the top-level `permissions:` block is absent or replaced
  // with a non-block form, but a job block with `permissions:\n      contents: read`
  // still exists. This is the exact pattern that causes the original parsePermissions
  // helper to fall through and silently pass the least-privilege lock.
  const withJobPermsOnly = [
    'on:',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  convert:',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo hi',
  ].join('\n');

  const withTopLevelWriteAll = [
    'permissions: write-all',
    '',
    'on:',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  convert:',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo hi',
  ].join('\n');

  const withTopLevelInlineMap = [
    'permissions: { contents: read, id-token: write }',
    '',
    'on:',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  convert:',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: echo hi',
  ].join('\n');

  it('returns null when top-level permissions block is absent — never falls through to a job block', () => {
    expect(parseTopLevelPermissions(withJobPermsOnly)).toBeNull();
  });

  it('returns null for `permissions: write-all` (scalar — not a least-privilege block)', () => {
    expect(parseTopLevelPermissions(withTopLevelWriteAll)).toBeNull();
  });

  it('returns null for inline-map top-level permissions (not a block — not least-privilege)', () => {
    expect(parseTopLevelPermissions(withTopLevelInlineMap)).toBeNull();
  });
});
