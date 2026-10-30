import { ReadOnlyError, type Backend } from './backend';
import { demoData } from './fixtures';
import type { Transcript } from './schemas';

/** Serves fixture data when no server is configured; every write is refused. */
export class DemoBackend implements Backend {
  readonly demo = true;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private get data() {
    return demoData(this.now());
  }

  sessionTranscript(sessionId: number) {
    const data = this.data.transcripts as Record<number, Transcript | undefined>;
    return Promise.resolve(data[sessionId] ?? null);
  }

  pendingQuestions() {
    return Promise.resolve(
      this.data.questions
        .filter((q) => q.status === 'pending')
        .sort((a, b) => a.deadline.localeCompare(b.deadline)),
    );
  }

  tree() {
    return Promise.resolve(this.data.tree);
  }

  pullRequests() {
    return Promise.resolve(
      [...this.data.pullRequests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  settings() {
    return Promise.resolve(this.data.settings);
  }

  usage() {
    return Promise.resolve(this.data.usage);
  }

  pipeline(projectId?: number) {
    const { pipeline, tree } = this.data;
    if (projectId === undefined) return Promise.resolve(pipeline);
    const { projects = {}, ...shared } = pipeline;
    const project = tree.find((p) => p.id === projectId);
    const home = project && (project.folderPath ?? `/Users/demo/${project.name}`);
    return Promise.resolve({
      ...shared,
      ...projects[projectId],
      project: { id: projectId, own: projectId in projects, dir: home ? `${home}/.loop-engineering` : null },
    });
  }

  offlineSince() {
    return Promise.resolve(null);
  }

  answer(): never {
    throw new ReadOnlyError();
  }
  updateProject(): never {
    throw new ReadOnlyError();
  }
  updateSettings(): never {
    throw new ReadOnlyError();
  }
  updatePipeline(): never {
    throw new ReadOnlyError();
  }
  createRequest(): never {
    throw new ReadOnlyError();
  }
  messageSession(): never {
    throw new ReadOnlyError();
  }
  endSession(): never {
    throw new ReadOnlyError();
  }
  setRigor(): never {
    throw new ReadOnlyError();
  }
  setAgentModel(): never {
    throw new ReadOnlyError();
  }
  openTerminal(): never {
    throw new ReadOnlyError();
  }
  skipCheck(): never {
    throw new ReadOnlyError();
  }
  webTerminal(): never {
    throw new ReadOnlyError();
  }
  openStageTerminal(): never {
    throw new ReadOnlyError();
  }

  /** A stream that only says `ready` and then keeps the connection alive; demo data never changes. */
  events(signal: AbortSignal) {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
        timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000);
        signal.addEventListener('abort', () => {
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }
}
