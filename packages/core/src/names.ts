// Project inputs that end up in filesystem paths and git arguments. Checked when a project is saved
// and again by the runner before use.

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A single path segment: letters, digits, ".", "_", "-"; never "." or "..", never leading "." or "-". */
export function isSafeRepoName(name: string): boolean {
  return name.length <= 100 && REPO_NAME.test(name);
}

/** A relative path inside a folder: no leading "/", no "." or ".." segments, no empty segments. */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.length > 255 || /[\\\0]/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * git's branch-name rules (`git check-ref-format --branch`), on a conservative character set:
 * letters, digits, ".", "_", "-", "/". No segment may be empty, start with "." or end with ".lock";
 * the name may not contain "..", end with "." or "/", be "@", or start with "-".
 */
export function isSafeBranchName(branch: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.length > 200) return false;
  if (branch === '@' || branch.startsWith('-') || branch.endsWith('.') || branch.includes('..')) return false;
  return branch.split('/').every((seg) => seg !== '' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}
