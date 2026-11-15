# Style project runtime

Generated style projects are rendered by
`remotion-runtime/src/style-render.mjs` from a temporary copy. The copy
receives a symlink to the pinned Remotion runtime dependencies; generated
projects never install packages or receive Portal credentials.
