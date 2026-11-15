import React from "react";
import { Composition } from "remotion";
import { StyleOverlay, type StyleProjectProps } from "./StyleOverlay";

const defaults: StyleProjectProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 1000,
  captions: [],
  visualEvents: [],
  layoutEvents: [],
  styleParams: { captionScale: 1, motionIntensity: 0.8, brollDensity: 0.5, colorAccent: "#c6f475" },
  captionStyle: { fontSize: 54, position: "bottom", marginV: 24, outline: 2, color: "#ffffff" },
};

export function RemotionRoot() {
  return (
    <Composition
      id="ReferenceStyle"
      component={StyleOverlay}
      width={defaults.width}
      height={defaults.height}
      fps={defaults.fps}
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
