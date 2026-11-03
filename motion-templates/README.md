# Motion Canvas template workspace

Motion Canvas is a separate MIT-licensed project for authoring and previewing
TypeScript motion-graphics templates. The official scaffold lives in
`wayne-mg/`, uses Motion Canvas 3.17.2 and Vite 5, and is not loaded into the
Wayne API process.

The starter scene is `wayne-mg/src/scenes/title-card.tsx`. It demonstrates a
short animated Hook card with title, subtext and Wayne brand colors. Use the
editor to preview or export its default image sequence. Assemble the sequence
into an MP4 with Wayne's local FFmpeg, then port its visual design to Remotion
when it needs to run against project `timeline.v1` data.

This separation avoids a second FFmpeg wrapper in the authoring project; Wayne's
existing FFmpeg pipeline can assemble image sequences. Templates are not
automatically executable in Wayne until they have been ported and pass the
Remotion alpha/render QC.

Additional template targets:

- `title_card`
- `emphasis`
- `cta`

Run the starter locally:

```bash
cd motion-templates/wayne-mg
npm ci
npm start
# In the editor, click Render and export the PNG sequence.
npm run assemble:preview
```

Generated output, dependencies and build files are ignored by Git. Do not add
Motion Canvas dependencies to `portal/package.json`.

The authoring project currently pins Vite 5 because that is the latest major
supported by Motion Canvas 3.17.2's Vite plugin. `npm audit` reports advisories
in this development dependency tree; the server binds only to `127.0.0.1` and
this project is not deployed. Recheck the plugin's Vite peer range before
upgrading it to a patched major version.

Official project: https://github.com/motion-canvas/motion-canvas
