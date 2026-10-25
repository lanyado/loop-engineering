export { extractJson, sameChoice, validateClassification, type Verdict } from './classification.js';
export { CliClassifier, ClassifierError, type CliClassifierOptions } from './cli-classifier.js';
export { FakeClassifier, FakeFolderSessions, FakeMessenger, fakeStartSession } from './fakes.js';
export {
  buildOptions,
  CANCEL_OPTION,
  decodeAnswer,
  MAX_ROUTE_OPTIONS,
  optionLabel,
  type Decoded,
} from './options.js';
export {
  buildClarifyPrompt,
  buildClassifierPrompt,
  buildSplitPrompt,
  cleanClarification,
  MAX_CLARIFYING_QUESTIONS,
  type ClarifyMail,
  type Clarification,
  cleanParts,
  cleanPlan,
  CLASSIFICATION_SCHEMA,
  MAX_PARTS,
  type Plan,
  type RequestPart,
} from './prompt.js';
export {
  DEFAULT_ROUTER_CONFIG,
  DELIVERY_DIR,
  deliverySentence,
  END_AND_START_FRESH,
  RESUME_AND_DELIVER,
  Router,
  type RouteOutcome,
  type RouterConfig,
  type RouterDeps,
} from './router.js';
export {
  ensureRouterSession,
  findRouterSession,
  ROUTER_PROJECT_NAME,
  ROUTER_SESSION_TITLE,
  routerProjectId,
} from './system.js';
export type {
  Classifier,
  ClassifierOutput,
  ClassifierProject,
  ClassifierSession,
  ClassifyInput,
  FolderSessions,
  FolderSessionState,
  RouteChoice,
  RouteTarget,
  SessionMessenger,
  StartSession,
} from './types.js';
