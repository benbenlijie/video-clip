export type CaptionCue = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  keywords?: string[];
  highlights?: string[];
};

export type VisualEvent = {
  id: string;
  type: string;
  startMs: number;
  endMs: number;
  text: string;
  subtext?: string;
  position?: string;
  sizeRatio?: number;
  coverage?: number;
};

export type LayoutEvent = {
  id: string;
  type: "full" | "punch_in" | "split" | "broll_cover" | "unknown";
  startMs: number;
  endMs: number;
};

export type StyleParams = {
  captionScale: number;
  motionIntensity: number;
  brollDensity: number;
  colorAccent: string;
};

export type CaptionStyle = {
  fontSize: number;
  position: "top" | "middle" | "bottom";
  marginV: number;
  outline: number;
  color: string;
};

export type StyleSpecV2 = {
  contract: "style-spec.v2" | "style-spec.v3";
  canvas: { aspectRatio: string; safeArea: { topRatio: number; rightRatio: number; bottomRatio: number; leftRatio: number } };
  title: {
    anchor: string;
    widthRatio: number;
    maxLines: number;
    panel: { enabled: boolean; color: string; opacity: number; radiusRatio: number; paddingXRatio: number; paddingYRatio: number; blurPx: number };
    primary: Record<string, string | number>;
    secondary: Record<string, string | number>;
    motion: { enter: Record<string, string | number>; exit: Record<string, string | number> };
  };
  identity: {
    anchor: string;
    maxWidthRatio: number;
    offsetYRatio?: number;
    maxLines?: number;
    panel: { enabled: boolean; color: string; opacity: number; radiusRatio: number; paddingXRatio: number; paddingYRatio: number; blurPx: number };
    primary: Record<string, string | number>;
    secondary: Record<string, string | number>;
    motion: { enter: Record<string, string | number>; exit: Record<string, string | number> };
  };
  captions: {
    grouping: string;
    maxCharsPerCue: number;
    anchor: string;
    maxWidthRatio: number;
    panel: { enabled: boolean; color: string; opacity: number; radiusRatio: number; paddingXRatio: number; paddingYRatio: number; blurPx: number };
    typography: Record<string, string | number>;
    highlight: Record<string, string | number>;
    motion: { enter: Record<string, string | number>; exit: Record<string, string | number> };
  };
  effects: Array<Record<string, string | number>>;
};

export type StyleProjectProps = {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  captions: CaptionCue[];
  visualEvents: VisualEvent[];
  layoutEvents: LayoutEvent[];
  styleParams: StyleParams;
  captionStyle?: CaptionStyle;
  styleSpec?: StyleSpecV2;
};
