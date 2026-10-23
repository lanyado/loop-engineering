/** "Folder" chip, plus an optional "no PRs" note; nothing for a git project. */
export function KindChip({ project, noPrsNote = false }: { project: { kind: string }; noPrsNote?: boolean }) {
  if (project.kind !== 'folder') return null;
  return (
    <span className="kind-line">
      <span className="pill kind" data-testid="kind-chip">
        Folder
      </span>
      {noPrsNote && (
        <span className="muted small" data-testid="no-prs-note">
          no PRs · edits in place
        </span>
      )}
    </span>
  );
}

/**
 * A folder project's path on its own line, starting at the left edge whatever the heading holds. It
 * wraps anywhere: folder paths are long and have no spaces. The full path is also the tooltip.
 */
export function FolderPath({ project }: { project: { kind: string; folderPath: string | null } }) {
  if (project.kind !== 'folder' || !project.folderPath) return null;
  return (
    <p className="muted small mono folder-path" data-testid="folder-path" title={project.folderPath}>
      {project.folderPath}
    </p>
  );
}
