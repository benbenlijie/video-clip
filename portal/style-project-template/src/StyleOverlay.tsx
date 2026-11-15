import React from "react";
import { AbsoluteFill } from "remotion";
import { CaptionLayer } from "./CaptionLayer";
import { LayoutLayer } from "./LayoutLayer";
import type { StyleProjectProps } from "./manifest";

export type { StyleProjectProps } from "./manifest";

function placement(position: string | undefined, sizeRatio: number): React.CSSProperties {
  if (position === "top_left") return { top: "8%", left: "8%", width: `${Math.round(sizeRatio * 100)}%` };
  if (position === "top_right") return { top: "8%", right: "8%", width: `${Math.round(sizeRatio * 100)}%` };
  if (position === "bottom_left") return { bottom: "20%", left: "8%", width: `${Math.round(sizeRatio * 100)}%` };
  if (position === "bottom_right") return { bottom: "20%", right: "8%", width: `${Math.round(sizeRatio * 100)}%` };
  return { top: "12%", left: "8%", right: "8%" };
}

export function StyleOverlay({ captions, captionStyle, layoutEvents, styleParams, visualEvents, width, height, fps }: StyleProjectProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", overflow: "hidden" }}>
      <LayoutLayer layoutEvents={layoutEvents} width={width} height={height} fps={fps} styleParams={styleParams} />
      <CaptionLayer captions={captions} width={width} height={height} fps={fps} styleParams={styleParams} captionStyle={captionStyle} />
      {visualEvents.map((event) => (
        <div key={event.id} style={{
          position: "absolute",
          ...placement(event.position, Math.max(0.08, Math.min(0.6, Number(event.sizeRatio) || 0.2))),
          color: styleParams.colorAccent,
          fontFamily: "Arial, sans-serif",
          fontSize: Math.max(14, Math.round(width * Math.max(0.08, Math.min(0.6, Number(event.sizeRatio) || 0.2)) * 0.16)),
          fontWeight: 700,
          lineHeight: 1.25,
          overflowWrap: "anywhere",
        }}>
          {event.text}
        </div>
      ))}
    </AbsoluteFill>
  );
}
