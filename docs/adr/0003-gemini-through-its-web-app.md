# Gemini through its web app's internal API

Gemini has no API for reading chat history, so threadslop Syncs it the way gemini.google.com loads its own sidebar: undocumented batchexecute calls, authenticated with Adwin's Google session cookies stored in the data directory and rotated by threadslop to keep them alive. That cookie is effectively a login to the whole Google account, and it ends up in kopia's backups of the data directory. Adwin accepted that risk because it is the only route that Syncs automatically and returns complete chats.

## Considered Options

- **Google Takeout import:** official, but manual (scheduled exports only every 2 months, renewed yearly, delivered to Drive). It drops turns (67 vs 87 in the longest chat), omits reasoning, and returns replies as HTML.
- **Data Portability API:** official and automatable, but it exports no Gemini data and isn't offered in Japan.
- **Scripting the Takeout website:** needs the same Google session plus a browser, and fights bot detection.
- **The HanaokaYuzu/Gemini-API Python library:** adds a Python runtime and AGPL code. Plain Bun `fetch` was enough in the spike.

## Consequences

- Google can change the call IDs or the positional response arrays at any time, so a Gemini Sync fails until threadslop's parser is fixed. `/health` shows that failure.
- Google throttles silently, replying HTTP 200 with no data. An empty response is a failure, never an empty chat, and each Sync reads a capped number of chats.
- A chat missing from the list can't be told apart from a deleted or auto-expired one, so Gemini Threads are never removed.
