import React from "react";
import { Composition } from "remotion";
import { Overlay } from "./Overlay.jsx";

const defaults = { events: [], width: 1920, height: 1080, fps: 30, durationMs: 1000 };

export function Root() {
  return (
    <Composition
      id="wayne-overlay"
      component={Overlay}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={30}
      defaultProps={defaults}
      calculateMetadata={({ props }) => ({
        width: Math.max(1, Math.round(Number(props.width) || defaults.width)),
        height: Math.max(1, Math.round(Number(props.height) || defaults.height)),
        fps: Math.max(1, Number(props.fps) || defaults.fps),
        durationInFrames: Math.max(1, Math.ceil((Math.max(1, Number(props.durationMs) || defaults.durationMs) / 1000) * Math.max(1, Number(props.fps) || defaults.fps))),
      })}
    />
  );
}
