import React from "react";
import { useCurrentFrame } from "remotion";
import type { LayoutEvent, StyleParams } from "./manifest";

export function LayoutLayer({ layoutEvents, width, height, fps, styleParams }: {
  layoutEvents: LayoutEvent[];
  width: number;
  height: number;
  fps: number;
  styleParams: StyleParams;
}) {
  const frame = useCurrentFrame();
  const timeMs = frame * 1000 / Math.max(1, fps);
  const active = layoutEvents.find((event) => timeMs >= event.startMs && timeMs < event.endMs);
  if (!active || active.type === "full" || active.type === "unknown") return null;
  return (
    <div style={{
      position: "absolute",
      inset: active.type === "broll_cover" ? "8%" : "12%",
      border: `${Math.max(2, Math.round(width * 0.004))}px solid ${styleParams.colorAccent}`,
      borderRadius: Math.round(width * 0.02),
      opacity: Math.min(1, Math.max(0, styleParams.motionIntensity)),
    }} />
  );
}
