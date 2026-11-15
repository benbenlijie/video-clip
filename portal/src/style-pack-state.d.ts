export type StylePanelStateKey = "empty" | "analyzed" | "generating" | "error" | "pending" | "approved" | "applied" | "stale" | "rejected";

export type StylePanelState = {
  key: StylePanelStateKey;
  label: string;
  detail: string;
  canAnalyze: boolean;
  canGenerate: boolean;
  canApprove: boolean;
  canApply: boolean;
  canPreview: boolean;
};

export type StyleCopy = {
  copyCaptions: boolean;
  copyRhythm: boolean;
  copyLayout: boolean;
  copyBroll: boolean;
  copyAudio: boolean;
};

export type StyleRolloutCapabilities = {
  manage: boolean;
  analyze: boolean;
  apply: boolean;
  preview: boolean;
  export: boolean;
  multi: boolean;
};

type StylePackLookupItem = {
  version?: number;
  manifest?: { sourceAnalysisId?: string };
};

export function stylePanelState(input?: {
  reference?: { analysisId?: string } | null;
  stylePack?: { id?: string; version?: number; status?: string } | null;
  busy?: boolean;
  error?: string;
  projectStyleId?: string | null;
  projectStyleVersion?: number | null;
}): StylePanelState;

export function defaultStyleCopy(analysis?: { capabilities?: { needsBroll?: boolean } } | null): StyleCopy;

export function pickStylePackForAnalysis<T extends StylePackLookupItem>(stylePacks?: T[], analysisId?: string): T | null;

export function gateStylePanelState(state: StylePanelState, capabilities?: {
  manage?: boolean;
  analyze?: boolean;
  apply?: boolean;
  preview?: boolean;
  export?: boolean;
  multi?: boolean;
}): StylePanelState;

export function selectStyleProof(project?: {
  styleVersion?: number;
  styleApplicationHash?: string;
  stylePack?: { version?: number } | null;
  artifacts?: Array<{
    kind?: string;
    name?: string;
    url?: string;
    generatedAt?: string;
    styleVersion?: number;
    styleProvenance?: { styleApplicationSha256?: string };
  }>;
}): {
  name: string;
  url: string;
  generatedAt?: string;
  styleVersion?: number;
} | null;
