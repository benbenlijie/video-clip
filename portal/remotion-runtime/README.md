# Wayne Remotion runtime

This is an isolated local renderer for Wayne `timeline.v1`. It renders only the
validated title/emphasis/CTA overlay layer; FFmpeg composites that layer over
the source video and the Portal records a separate preview, transparent overlay
and `render-manifest.v1`. The default Claude Code/FFmpeg/HyperFrames final
export remains unchanged.

## Install and verify

```bash
cd /home/ben/Documents/projects/video-clip/portal/remotion-runtime
npm ci
npm run verify
```

The verify command renders a real short composition, probes its ProRes profile
and alpha pixel format, extracts the alpha plane, and checks that both fully
transparent and visible pixels exist. The first render may download Remotion's
official headless Chromium shell (about 99 MB) into its local browser cache; no
render API or cloud account is used. The Portal exposes the optional action
through `POST /api/projects/:id/render/remotion-preview` after this runtime is
installed.

Packages are pinned to Remotion `4.0.539` and React `19.3.1`. Zod is overridden
to `4.6.7` because `4.0.539` otherwise pins a vulnerable `4.5.4` transitively.
The local npm audit passed after the override. Keep all `@remotion/*` packages
on the same exact version.

## Free use boundary

The current intended use is one person or a team/organization of at most three
people. Remotion's current Free License FAQ includes automation for eligible
users. Recheck official terms if the team grows or usage changes:

- https://www.remotion.dev/docs/license/pricing
- https://www.remotion.dev/docs/license/faq

## Runtime boundary

The renderer accepts only JSON data from `timeline.v1`, creates its own
composition bundle, rejects unsupported event types and text sizes, refuses to
overwrite outputs, and receives no API credentials. It does not accept user
authored JSX or arbitrary file paths from the browser.
