import type * as z from 'zod';
import { BackendError, type Backend } from './backend';
import { responses, type PipelineUpdate, type Rigor } from './schemas';

export interface HttpBackendOptions {
  /** e.g. https://loop.example.com (no trailing /api). */
  serverUrl: string;
  token: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Per request, except the event stream. Default 10 s. */
  timeoutMs?: number;
}

export class HttpBackend implements Backend {
  readonly demo = false;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpBackendOptions) {
    this.base = options.serverUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async pendingQuestions() {
    return (await this.get('/questions?status=pending', responses.questions)).questions;
  }

  async answer(questionId: number, answer: string) {
    // 409 carries the same body as 200: { accepted: false, question } when someone answered first.
    return this.send('POST', `/questions/${questionId}/answer`, { answer }, responses.answer, [409]);
  }

  async tree() {
    return (await this.get('/tree', responses.tree)).projects;
  }

  async updateProject(id: number, patch: { autoMerge?: boolean }) {
    return (await this.send('PATCH', `/projects/${id}`, patch, responses.project)).project;
  }

  async pipeline() {
    return this.get('/pipeline', responses.pipeline);
  }

  async updatePipeline(update: PipelineUpdate) {
    return this.send('PUT', '/pipeline', update, responses.pipeline);
  }

  async skipCheck(prId: number, check: string, skip: boolean) {
    await this.send('POST', `/prs/${prId}/skip`, { check, skip }, responses.skipped);
  }

  async openStageTerminal(prId: number, stage: string) {
    await this.send('POST', `/prs/${prId}/terminal`, { stage }, responses.terminal);
  }

  async webTerminal(target: { sessionId: number } | { prId: number; stage: string }) {
    const r =
      'sessionId' in target
        ? await this.send('POST', `/sessions/${target.sessionId}/web-terminal`, {}, responses.webTerminal)
        : await this.send(
            'POST',
            `/prs/${target.prId}/web-terminal`,
            { stage: target.stage },
            responses.webTerminal,
          );
    return r.url;
  }

  async sessionTranscript(sessionId: number) {
    return (await this.get(`/sessions/${sessionId}/transcript`, responses.transcript)).transcript;
  }

  async openTerminal(sessionId: number) {
    await this.send('POST', `/sessions/${sessionId}/terminal`, {}, responses.terminal);
  }

  async setRigor(sessionId: number, rigor: Rigor) {
    await this.send('PATCH', `/sessions/${sessionId}`, { rigor }, responses.rigor);
  }

  async setAgentModel(sessionId: number, agent: string, model: string | null) {
    await this.send('PUT', `/sessions/${sessionId}/models/${agent}`, { model }, responses.agentModel);
  }

  async endSession(sessionId: number) {
    // No force: a git session with uncommitted changes is refused, and the human sees why.
    return (await this.send('POST', `/sessions/${sessionId}/end`, {}, responses.session)).session;
  }

  async pullRequests() {
    return (await this.get('/prs', responses.prs)).pullRequests;
  }

  async settings() {
    return (await this.get('/settings', responses.settings)).settings;
  }

  async updateSettings(patch: Record<string, unknown>) {
    return (await this.send('PATCH', '/settings', patch, responses.settings)).settings;
  }

  async createRequest(input: { text: string; projectId: number }) {
    return (await this.send('POST', '/requests', input, responses.request)).request;
  }

  async messageSession(sessionId: number, text: string) {
    return (await this.send('POST', '/requests', { text, sessionId }, responses.request)).request;
  }

  async usage() {
    return (await this.get('/usage', responses.usage)).usage;
  }

  async offlineSince() {
    return (await this.get('/loop/status', responses.loopStatus)).offlineSince;
  }

  async events(signal: AbortSignal) {
    const res = await this.fetchImpl(`${this.base}/api/events`, {
      headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    });
    if (!res.ok || !res.body) throw new BackendError(res.status, `event stream failed (${res.status})`);
    return res;
  }

  private get<S extends z.ZodType>(path: string, schema: S) {
    return this.send('GET', path, undefined, schema);
  }

  private async send<S extends z.ZodType>(
    method: string,
    path: string,
    body: unknown,
    schema: S,
    okStatuses: number[] = [],
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.options.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BackendError(
        503,
        `cannot reach the server: ${error instanceof Error ? error.message : 'error'}`,
      );
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok && !okStatuses.includes(res.status)) {
      const parsed = responses.error.safeParse(json);
      // 401 means DASHBOARD_TOKEN is wrong on one side; say so instead of echoing the server.
      const message =
        res.status === 401
          ? 'the server rejected DASHBOARD_TOKEN'
          : parsed.success
            ? parsed.data.error
            : `server error ${res.status}`;
      throw new BackendError(res.status, message);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new BackendError(502, `unexpected response from ${method} /api${path}`);
    return parsed.data;
  }
}
