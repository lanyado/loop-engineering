import type { StageRuns } from './stages.js';

/*
 * When a check runs ("runs" in its stage file): on every PR, or only when the PR's diff changes a
 * kind of file. Each kind is a test on a changed file's path.
 */

const TEST_FILE =
  /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|_spec\.rb$|(^|\/)test_[^/]*\.py$/i;
/** Docs by their file type only: a source file in a docs folder is still code. */
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc)$/i;
/** UI file types: a diff that touches none of them has nothing for a browser to check. */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less)$/i;
/** Plain .js/.mjs counts too when it sits where pages and their scripts live. */
const UI_DIR = /(^|\/)(components|pages|app|public|static|styles|games|site|web|views|layouts)\//i;
const SOURCE = /\.([cm]?[jt]sx?|py|go|rb|java|kt|rs|php|cs|swift|scala|exs?|c|cc|cpp|h|hpp)$/i;
/** Tool config (vite.config.ts, tailwind.config.js, …) is not server code. */
const CONFIG = /\.config\.[cm]?[jt]s$/i;
const DEPENDENCIES =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/;
const DATABASE = /(^|\/)(migrations?|migrate)\/|\.sql$|(^|\/)schema\.(prisma|rb)$/i;
const INFRA =
  /(^|\/)(\.github|\.circleci|k8s|kubernetes|helm|terraform|infra|deploy)\/|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|\.gitlab-ci\.yml|Procfile|vercel\.json|netlify\.toml|fly\.toml|render\.yaml)$|\.tf$/i;

const isTest = (f: string) => TEST_FILE.test(f);
const isUi = (f: string) => !isTest(f) && (UI_FILE.test(f) || (UI_DIR.test(f) && /\.[cm]?js$/i.test(f)));

const KINDS: Record<Exclude<StageRuns, 'always'>, (file: string) => boolean> = {
  'code-changes': (f) => !DOC_FILE.test(f),
  'ui-changes': isUi,
  'server-changes': (f) => SOURCE.test(f) && !isUi(f) && !isTest(f) && !CONFIG.test(f),
  'test-changes': isTest,
  'docs-changes': (f) => DOC_FILE.test(f),
  'dependency-changes': (f) => DEPENDENCIES.test(f),
  'database-changes': (f) => DATABASE.test(f),
  'infra-changes': (f) => INFRA.test(f),
};

/** Whether a check with this `runs` setting runs on a PR with this unified diff. */
export function runsOn(runs: StageRuns, diff: string): boolean {
  if (runs === 'always') return true;
  // "a/<path> b/<path>": the same path twice, so a path with spaces still splits at the one " b/".
  const files = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((m) => m[2]!);
  return files.some(KINDS[runs]);
}
