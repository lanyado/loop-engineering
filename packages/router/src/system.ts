import type { Session, Store } from '@loop-engineering/core';

/**
 * Questions belong to a session in core (questions.session_id is NOT NULL), and a routing question
 * comes before the request has a session. Rather than make session_id nullable (a table rebuild,
 * and Question.sessionId turning nullable for every channel and the dashboard), routing questions
 * belong to one reserved project and session that the router creates on demand. Its id is stored in
 * settings (router_session_id), so it is found by id, never by name. The session is created "ended",
 * so the runner, the usage monitor and the active-session lists never touch it; the project is never
 * marked for direct input, never offered or routed to, hidden from the dashboard lists, and the
 * dashboard API refuses tasks for it and its deletion.
 */
export const ROUTER_PROJECT_NAME = 'Direct input (router)';
export const ROUTER_SESSION_TITLE = 'Routing questions';

/** The reserved session, if the router has made it. */
export function findRouterSession(store: Store): Session | undefined {
  const id = store.settings.getRouterSessionId();
  return id === null ? undefined : store.sessions.get(id);
}

/** Id of the reserved project, or null before the first routing question. */
export function routerProjectId(store: Store): number | null {
  return findRouterSession(store)?.projectId ?? null;
}

/** The reserved session, created on the first routing question (again if it was ever deleted). */
export function ensureRouterSession(store: Store): Session {
  return store.transaction(() => {
    const existing = findRouterSession(store);
    if (existing) return existing;
    // Project names are unique; a user project may already have the usual name.
    let name = ROUTER_PROJECT_NAME;
    for (let n = 2; store.projects.getByName(name); n++) name = `${ROUTER_PROJECT_NAME} ${n}`;
    const project = store.projects.create({ name, markedForDirectInput: false });
    const session = store.sessions.create({
      projectId: project.id,
      title: ROUTER_SESSION_TITLE,
      model: 'none',
      branch: 'router',
      status: 'ended',
    });
    store.settings.setRouterSessionId(session.id);
    return session;
  });
}
