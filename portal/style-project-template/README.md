# Reference style project scaffold

This scaffold is the only starting point for generated reference-style
Remotion projects. It is intentionally dependency-restricted and receives
validated JSON props only:

- `captions`
- `visualEvents`
- `layoutEvents`
- `styleParams`
- optional `captionStyle` for user-side caption size, position, outline, and color

Generated projects must not fetch network resources, read environment
variables, write files, or bundle reference footage/audio. The Portal
validates the source and renders it in an isolated process.
