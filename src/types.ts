export type Contribution = "definition" | "condition" | "distinction" | "other";

export interface QueryCriteria {
  mode: "default" | "generic";
  instructions?: string;
  true?: string;
  false?: string;
  criteria?: Array<{ id: string; instructions: string; true: string; false: string; weight?: number }>;
}

export interface QuerySpec {
  question: string;
  folder: string;
  contextPaths: string[];
  criteria: QueryCriteria;
  limit?: number;
  threshold?: number;
  adjacent?: number;
}

export interface Block {
  id: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  searchText: string;
  /** Text assembled for display when a list item needs ancestor context. */
  renderText?: string;
  kind: "paragraph" | "heading" | "list" | "fence" | "table" | "callout" | "blockquote" | "yaml";
  headingPath: string[];
  parentId?: string;
  sectionId?: string;
}

export interface IndexedFile {
  path: string;
  mtime: number;
  blocks: Block[];
}

export interface Candidate extends Block {
  lexicalScore: number;
  retrievalScore?: number;
  semanticScore?: number;
}

export interface Judgement {
  manuallyIncluded?: boolean;
  candidate: Candidate;
  score: number;
  contribution: Contribution;
  scores: Record<string, number>;
}

export interface JevAnswer {
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface QueryStats {
  searchable: number;
  shortlisted: number;
  overlapRemoved: number;
  windowLimit: number;
  truncated: boolean;
  checked: number;
  cached: number;
  shared: number;
  requested: number;
  requests: number;
  inputTokens: number;
  requestMs: number;
  retries: number;
  skipped: number;
  passed: number;
  contextChars: number;
  threshold: number;
}

export interface QueryResult {
  status: "ready" | "needs-key" | "error" | "empty";
  judgements: Judgement[];
  belowThreshold?: Judgement[];
  stats?: QueryStats;
  candidates: Candidate[];
  error?: string;
  warning?: string;
  selection?: "jev" | "local";
}
