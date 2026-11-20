---
name: broll-sources
description: Find and fetch licensed B-roll from Mixkit, Coverr, and 影视飓风 with visible previews, explicit commercial-use status, provenance, and workspace-safe downloads. Use when Pexels/Pixabay lack the needed shot or when a curated, cinematic, or 4K Log clip is required; do not use for arbitrary web scraping, music-only requests, or bypassing a site's login, identity verification, payment, or order flow.
---

# B-roll Sources

Use the `broll-sources` MCP to search candidates, inspect the real thumbnail, then download only the selected clip. Keep source URLs, license names, license URLs, and SHA-256 in the edit record.

## Provider rules

- **Mixkit**: Use English queries. The free 720p file may be under the **Restricted License** and personal-use only. Never use a Restricted clip in a commercial project. A commercial 1080p version may require an Envato subscription; do not treat the free 720p file as that license.
- **Coverr**: Prefer non-premium, published results. Coverr's license permits free commercial use without attribution; still check identifiable people, brands, and private property. Use the 1080p `mp4Download` URL when available.
- **影视飓风**: Search and inspect only the public catalogue with this tool. The user must open the official detail page, choose the correct license (normally **企业商用** for company work), submit the 0-yuan order, and provide the resulting Baidu Pan share link. Do not automate login, real-name verification, order submission, or CAPTCHA. Never write a share link containing `pwd` to an audit log or send it to a third party.

## Workflow

1. Call `search_broll_sources` with a concrete visual query, the needed orientation, and a small limit. Use `commercialOnly: true` for client or monetized work.
2. Call `inspect_broll_candidate` for every shortlisted clip. Check the frame, motion, composition, and text overlays; a title or keyword match is not visual proof.
3. For Mixkit/Coverr, call `download_broll_candidate` with `licenseAcknowledged: true`. For a Mixkit Restricted clip, stop unless the user explicitly confirms personal-only use and passes `allowRestricted: true`.
4. For 影视飓风, open `sourceUrl`, let the user complete the official order, then call `download_broll_candidate` with `shareUrl`, `match`/`index`, and `licenseAcknowledged: true`.
5. The tool returns a workspace-relative path plus ffprobe metadata and SHA-256. Add the clip as a `broll` asset; do not use a preview URL as the final asset.
6. For 影视飓风 Log footage, apply the matching camera LUT and convert to Rec.709 before project ingestion. The current renderer does not do Log-to-Rec.709 conversion. Normalize to 1080p and the project's frame rate; a 4K source can be kept outside the project as the archive copy.

## Hard boundaries

- Do not download an arbitrary URL. The MCP only accepts the candidate handle created by the immediately preceding search.
- Do not use a Mixkit Restricted clip in a commercial video, even if the download succeeds.
- Do not claim that a 影视飓风 download is licensed merely because the file exists. The user's order and selected license are the evidence.
- Do not build a shared raw-footage library across users or projects. License and attributable use are per work/project.
- Do not use the short preview video as the final B-roll. It is a selection aid only.

## MCP

The project-integrated `video` MCP exposes:

- `search_broll_sources`
- `inspect_broll_candidate`
- `download_broll_candidate`

Standalone server:

```json
{
  "mcpServers": {
    "broll-sources": {
      "command": "node",
      "args": ["portal/server/broll-source-tools.mjs", "/absolute/path/to/workdir", "/absolute/path/to/workdir/.audit/broll-sources.jsonl"]
    }
  }
}
```

Mixkit/Coverr direct downloads go to the workspace `downloads/` directory and are bounded to 100MB each. 影视飓风 files come through Baidu Pan and may be larger; select one file with `match`/`index`, check its size, and create a 1080p proxy before project ingestion. The multi-asset workflow accepts at most 500MB per asset and 5GB per project.

Offline regression:

```bash
cd portal && npm run verify:broll-sources
```
