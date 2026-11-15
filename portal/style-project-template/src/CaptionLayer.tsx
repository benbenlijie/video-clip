import React from "react";
import { useCurrentFrame } from "remotion";
import type { CaptionCue, CaptionStyle, StyleParams } from "./manifest";

function verticalStyle(style: CaptionStyle | undefined, height: number) {
  const position = style?.position || "bottom";
  const margin = Math.max(0, Number(style?.marginV) || 0);
  if (position === "top") return { top: margin };
  if (position === "middle") return { top: "50%", transform: "translateY(-50%)" };
  return { bottom: margin };
}

export function CaptionLayer({ captions, width, height, fps, styleParams, captionStyle }: {
  captions: CaptionCue[];
  width: number;
  height: number;
  fps: number;
  styleParams: StyleParams;
  captionStyle?: CaptionStyle;
}) {
  const frame = useCurrentFrame();
  const timeMs = (frame / fps) * 1000;
  const active = captions.find((cue) => timeMs >= cue.startMs && timeMs < cue.endMs);
  if (!active) return null;
  const fontSize = Math.max(8, Number(captionStyle?.fontSize) || Math.round(width * 0.05 * styleParams.captionScale));
  const outline = Math.max(0, Number(captionStyle?.outline) || 0);
  const color = /^#[0-9a-f]{6}$/i.test(String(captionStyle?.color || "")) ? String(captionStyle?.color) : "#ffffff";
  return (
    <div style={{
      position: "absolute",
      left: "8%",
      right: "8%",
      ...verticalStyle(captionStyle, height),
      textAlign: "center",
      color,
      fontSize,
      fontWeight: 800,
      lineHeight: 1.1,
      WebkitTextStroke: outline > 0 ? `${outline}px rgba(0,0,0,.9)` : undefined,
      paintOrder: "stroke fill",
      textShadow: "0 2px 8px rgba(0,0,0,.65)",
    }}>
      {active.text}
    </div>
  );
}
