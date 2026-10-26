import type { Project, Session, Store } from '@loop-engineering/core';
import { sameChoice } from './classification.js';
import type { RouteChoice } from './types.js';

export const CANCEL_OPTION = 'Cancel';
/** ask_human allows 10 options; one is Cancel. */
export const MAX_ROUTE_OPTIONS = 9;

const truncate = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const projectLabel = (project: Project) => truncate(project.name, 60);

/**
 * "shop: new session" or "shop: session 'fix login' (#12)". The session id makes a label decodable
 * after a restart, when only the stored question (its options and answer) is left.
 */
export function optionLabel(choice: RouteChoice, store: Store): string | null {
  const project = store.projects.get(choice.projectId);
  if (!project) return null;
  if (choice.target.kind === 'new') return `${projectLabel(project)}: new session`;
  const session = store.sessions.get(choice.target.sessionId);
  if (!session) return null;
  return `${projectLabel(project)}: session '${truncate(session.title, 80)}' (#${session.id})`;
}

/**
 * Options for a routing question: the classifier's candidates first, then a new session in every
 * eligible project, then their open sessions, up to MAX_ROUTE_OPTIONS, and Cancel last.
 *
 * The recommended option (the 15-minute default) is the top candidate only when the classifier
 * proposed one; otherwise it is Cancel, so a request nobody could place never starts an autonomous
 * session in an arbitrary project just because no one answered.
 */
export function buildOptions(
  candidates: RouteChoice[],
  eligible: { project: Project; sessions: Session[] }[],
  store: Store,
): { options: string[]; recommended: string } {
  const choices: RouteChoice[] = [...candidates];
  for (const { project } of eligible) choices.push({ projectId: project.id, target: { kind: 'new' } });
  for (const { project, sessions } of eligible) {
    for (const s of sessions)
      choices.push({ projectId: project.id, target: { kind: 'session', sessionId: s.id } });
  }
  const picked: RouteChoice[] = [];
  const labels: string[] = [];
  for (const choice of choices) {
    if (labels.length >= MAX_ROUTE_OPTIONS) break;
    if (picked.some((c) => sameChoice(c, choice))) continue;
    const label = optionLabel(choice, store);
    if (!label || labels.includes(label) || label === CANCEL_OPTION) continue;
    picked.push(choice);
    labels.push(label);
  }
  const recommended = candidates.length > 0 ? (labels[0] ?? CANCEL_OPTION) : CANCEL_OPTION;
  return { options: [...labels, CANCEL_OPTION], recommended };
}

export type Decoded = { kind: 'cancel' } | { kind: 'route'; choice: RouteChoice } | { kind: 'unknown' };

/**
 * Reads the human's answer to a routing question. It is usually one of the options; a free-text
 * reply (a chat channel) is matched to an option ignoring case, then to a project name, which means a new
 * session there. Anything else is unknown.
 */
export function decodeAnswer(answer: string, options: string[], projects: Project[], store: Store): Decoded {
  const wanted = answer.trim().toLowerCase();
  const option = options.find((o) => o.toLowerCase() === wanted);
  if (option !== undefined) return decodeOption(option, projects, store);
  const project = projects.find((p) => p.name.trim().toLowerCase() === wanted);
  return project
    ? { kind: 'route', choice: { projectId: project.id, target: { kind: 'new' } } }
    : { kind: 'unknown' };
}

function decodeOption(option: string, projects: Project[], store: Store): Decoded {
  if (option === CANCEL_OPTION) return { kind: 'cancel' };
  const session = /: session '.*' \(#(\d+)\)$/s.exec(option);
  if (session) {
    const found = store.sessions.get(Number(session[1]));
    return found
      ? {
          kind: 'route',
          choice: { projectId: found.projectId, target: { kind: 'session', sessionId: found.id } },
        }
      : { kind: 'unknown' };
  }
  const fresh = /^(.*): new session$/s.exec(option);
  const project = fresh && projects.find((p) => projectLabel(p) === fresh[1]);
  return project
    ? { kind: 'route', choice: { projectId: project.id, target: { kind: 'new' } } }
    : { kind: 'unknown' };
}
