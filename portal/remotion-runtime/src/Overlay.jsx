import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

function eventStyle(event, index, frame, fps, width, height) {
  const start = Math.max(0, Math.round((Number(event.startMs) / 1000) * fps));
  const end = Math.max(start + 1, Math.round((Number(event.endMs) / 1000) * fps));
  const fadeIn = Math.max(1, Math.min(12, Math.floor((end - start) * 0.2)));
  const fadeOut = Math.max(1, Math.min(10, Math.floor((end - start) * 0.18)));
  const entranceOpacity = interpolate(frame, [start, start + fadeIn], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitOpacity = interpolate(frame, [Math.max(start, end - fadeOut), end], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(entranceOpacity, exitOpacity);
  const portrait = height > width;
  const title = event.type === "title_card";
  const cta = event.type === "cta";
  const compact = portrait ? Math.round(width * 0.075) : Math.round(height * 0.064);
  const fontSize = title ? compact : Math.round(compact * 0.78);
  const translateY = Math.round(height * (title ? 0.025 : 0.018)) * (1 - opacity);
  const horizontal = title ? "50%" : cta ? "88%" : "12%";
  const vertical = title ? (portrait ? "22%" : "18%") : cta ? "84%" : "78%";

  return {
    position: "absolute",
    left: horizontal,
    top: vertical,
    width: `${portrait ? 84 : 76}%`,
    transform: `translate(-${title ? "50" : cta ? "100" : "0"}%, -50%) translateY(${translateY}px)`,
    opacity,
    padding: `${Math.round(height * 0.025)}px ${Math.round(width * 0.035)}px`,
    color: "#f3f5ee",
    background: "rgba(13, 17, 14, 0.9)",
    borderLeft: `${Math.max(4, Math.round(width * 0.006))}px solid ${cta ? "#f58c53" : "#c6f475"}`,
    borderTop: `${Math.max(2, Math.round(height * 0.003))}px solid #f58c53`,
    boxShadow: "0 16px 60px rgba(0,0,0,.25)",
    fontFamily: "Arial, sans-serif",
    textAlign: title ? "center" : "left",
    zIndex: index + 1,
  };
}

export function Overlay({ events = [], width = 1920, height = 1080, fps = 30 }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "transparent", overflow: "hidden" }}>
      {events.map((event, index) => (
        <div key={event.id || index} style={eventStyle(event, index, frame, fps, width, height)}>
          <div style={{ fontSize: event.type === "title_card" ? Math.round(height > width ? width * 0.07 : height * 0.074) : Math.round(height > width ? width * 0.062 : height * 0.062), fontWeight: 800, lineHeight: 1.03, overflowWrap: "anywhere" }}>
            {event.text || ""}
          </div>
          {event.subtext ? <div style={{ marginTop: Math.round(height * 0.015), color: "#c6f475", fontSize: Math.max(16, Math.round(height * 0.027)), fontWeight: 600, lineHeight: 1.1 }}>{event.subtext}</div> : null}
        </div>
      ))}
    </AbsoluteFill>
  );
}
