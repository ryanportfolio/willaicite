export type EvidenceStatus = 'pass' | 'fail' | 'warn' | 'info' | 'unverified';

export interface Evidence {
  status: EvidenceStatus;
  message: string;
}

export interface Recommendation {
  dimension: string;
  action: string;
  /** The mechanism or research number that justifies the action. Never empty. */
  why: string;
  /** 1 = low, 2 = medium, 3 = high */
  impact: 1 | 2 | 3;
  /** 1 = low effort, 2 = medium, 3 = high */
  effort: 1 | 2 | 3;
}

export interface DimensionResult {
  key: string;
  name: string;
  /** Relative weight used in the overall score. 0 = informational only. */
  weight: number;
  /** 0-100, or null when the check could not run ("could not verify"). */
  score: number | null;
  evidence: Evidence[];
  recommendations: Recommendation[];
}

export interface AuditResult {
  tool: string;
  version: string;
  url: string;
  finalUrl: string | null;
  fetchedAt: string;
  /** Weighted average of scoreable dimensions, or null when nothing could be verified. */
  overallScore: number | null;
  verdict: string;
  dimensions: DimensionResult[];
  informational: DimensionResult[];
  pagesAudited: string[];
  limitations: string[];
}
