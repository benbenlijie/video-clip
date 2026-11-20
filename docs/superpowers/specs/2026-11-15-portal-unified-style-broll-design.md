# Portal Unified Style and B-roll Editing Design

## Intent

Make the portal's single-video Claude Code workflow the authoritative path for
reference-style editing with fluency cleanup and content-driven B-roll.

The current portal already has three isolated capabilities: approved StylePacks,
the fluency MCP pass, and B-roll search/download. The missing product loop is
that users can search stock B-roll from the web UI but cannot add a candidate to
the project and continue through the normal plan/render flow without manually
downloading and uploading it.

## Goals

- A searched B-roll candidate can be imported into the current project from the
  portal with one action.
- Imported B-roll has server-controlled provider provenance, license metadata,
  a local SHA-256 and a validated video stream.
- Import invalidates the old plan so a stale render cannot silently omit the new
  asset.
- The normal Claude Code plan uses the active StylePack, runs the fluency pass,
  selects `brollEvents`, and renders through the existing Remotion main path.
- The same secure download primitive is shared by the portal and Claude MCP.

## Non-goals

- Adding a second style engine or bypassing StylePack approval.
- Copying B-roll from the reference video when the reference has none.
- Enabling online stock search for `multi-asset-v1`; that mode continues to use
  the uploaded asset library and the `broll` role.
- Accepting arbitrary download URLs from the browser.
- Calling paid B-roll or Claude APIs in automated tests.

## Product Rule

Reference style and B-roll are independent layers. The reference StylePack owns
typography, title/identity treatment, caption motion, emphasis and layout. The
editorial plan owns whether a content-driven B-roll insert improves
comprehension. A reference with zero B-roll therefore does not force the user's
video to remain a talking head when relevant licensed B-roll is available.

## Approaches Considered

1. Browser posts the candidate download URL. This is the smallest diff but
   creates an SSRF and provenance trust boundary in the browser input.
2. Server stores short-lived candidate handles from the preceding search and
   imports only a handle bound to the project. This adds a small registry but
   keeps downloads and provenance server-controlled. Selected.
3. Depend only on Claude MCP search. This works inside an agent run but does not
   let a portal user review and select a candidate. Rejected.

## Interfaces

`POST /api/projects/:id/broll/search` keeps its existing response and adds a
UUID `candidateHandle` to each candidate.

`POST /api/projects/:id/broll/import`

```json
{ "candidateHandle": "uuid" }
```

The returned project has one additional `brollAssets` entry containing:

```json
{
  "id": "uuid",
  "filename": "broll-pexels-123-uuid.mp4",
  "title": "candidate title",
  "durationMs": 8000,
  "width": 1080,
  "height": 1920,
  "licenseConfirmed": true,
  "provider": "pexels",
  "providerId": "123",
  "sourceUrl": "https://www.pexels.com/video/...",
  "licenseName": "Pexels License",
  "licenseUrl": "https://www.pexels.com/license/",
  "sha256": "hex"
}
```

The project returns to `transcript_ready`, keeps the approved StylePack, clears
the old `plan` and `qc`, and requires a fresh plan before export. This mirrors
the existing licensed B-roll upload behavior.

## Constraints

- Candidate handles expire after 30 minutes and are bound to one project.
- Files are limited to 100 MB and must resolve from an allowlisted official CDN.
- One redirect is allowed only when its destination is also allowlisted.
- A project can hold at most 12 B-roll assets.
- Duplicate provider IDs or file hashes are rejected.
- Local absolute paths never appear in public API responses.
- Existing B-roll upload and Claude MCP behavior remain backward compatible.

## Acceptance

- A valid handle imports a real probed B-roll asset and returns a redacted
  project view.
- Unknown, expired or cross-project handles are rejected.
- Non-official URLs and oversized responses are rejected by the shared
  downloader.
- Importing clears the current plan and prevents export until replanning.
- `npm run typecheck`, `npm run build`, targeted tests and `npm run verify`
  pass.
