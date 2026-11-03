# OpenChatCut sidecar adapter

OpenChatCut remains an independently installed and independently versioned
AGPL-3.0-or-later application. This directory will contain only the Wayne-side
protocol adapter and file-exchange documentation; it must not vendor or copy
OpenChatCut source code.

Current local research copy: `../openchatcut-src/` (v0.2.17, Remotion 4.0.537).
The local MCP endpoint observed during the earlier smoke test was
`http://localhost:5199/api/external-mcp/mcp`; verify the active endpoint before
use. The required edit flow is `begin_edit_session` → edit tools with the
returned id → `review_edit_session` → read back applied state.

Start the local sidecar with Node 24 from `openchatcut-src/` using
`npm run dev`. Its predev step syncs MediaPipe and verifies the tool catalog,
then provisions the optional whisper.cpp CLI. If that GitHub release download
is unavailable, the UI/MCP may still be smoke-tested with the checkout's
isolated profile runner without running the predev provisioning step; that
does not enable local ASR. In Wayne, configure `OPENCHATCUT_MCP_URL` and the
sidecar's `OPENCHATCUT_MCP_TOKEN` in the Portal server environment, then use
`POST /api/engines/openchatcut/probe` or the Services panel's read-only probe.
`GET /api/engines/openchatcut/projects` returns only project IDs, names, and
update times to a loopback Wayne page. Selecting a target in the Services panel
is page-local and does not switch the OpenChatCut editor or upload media.
Neither read-only action starts an edit session.

Isolated OpenChatCut development profiles have profile-specific MCP tokens. If
the Portal server cannot authenticate using `~/.openchatcut/mcp-token`, pass the
active profile's token through the server-only `OPENCHATCUT_MCP_TOKEN` setting;
never place it in a `VITE_*` variable or browser code. Keep the first media
import in `manual` approval mode and confirm it in OpenChatCut before bytes are
transferred.

The profile-isolated Vite editor and local MCP endpoint have both been verified
on Node 24. The initial recommended predev path stopped while fetching the
optional whisper.cpp release, so local transcription was not part of that
verification.

Initial exchange format: `timeline.v1` JSON plus media references. Preferred
outputs are MP4/SRT/FCPXML or complete project export. Do not expose this
sidecar on a public network without a Bearer token and network restrictions.

Official license: `../openchatcut-src/LICENSE` (AGPL-3.0). Free local use does
not remove the license obligations that apply to modification or redistribution.
