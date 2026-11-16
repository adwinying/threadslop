# ChatGPT through its internal API

OpenAI offers a Plus user no automatable way to read chat history, so threadslop Syncs ChatGPT the way chatgpt.com loads its own sidebar: the undocumented `backend-api`, reached with plain `fetch` and Adwin's `__Secure-next-auth.session-token` cookie stored in the data directory. Each Sync exchanges the cookie for a short-lived access token. A spike on nas (#36) passed first: Cloudflare challenged none of its requests, and the session survived the cookie rotation ChatGPT does on each sign-in.

The cookie is effectively a login to Adwin's whole OpenAI account, and it ends up in kopia's backups of the data directory. Anyone holding a backup can read every chat and act as Adwin until the session expires or is signed out.

OpenAI's consumer Terms of Use (effective 2026-01-01) list, under "What you cannot do": "Automatically or programmatically extract data or Output." Syncing is exactly that, so OpenAI could suspend the account over it. Adwin accepted both risks because this is the only route that Syncs automatically and returns complete chats.

## Considered Options

- **Compliance API:** official and automatable, but only for Enterprise and Edu workspaces.
- **Manual "Export data":** official, but each export is requested by hand, takes up to 7 days, and its link expires in 24 hours.
- **Headless browser:** passes Cloudflare more reliably, but adds a browser to the container and still needs the same session. Plain `fetch` was enough in the spike.
- **Dropping ChatGPT:** leaves the one place past AI work lives that threadslop can't recall.

## Consequences

- OpenAI can change the endpoints or their shapes at any time, so a ChatGPT Sync fails until threadslop's parser is fixed. `/health` shows that failure, naming Cloudflare when it challenged.
- Each Sync reads a capped number of chats, paced apart, so a backlog drains over several Syncs.
- A chat missing from the list can't be told apart from a deleted one, so ChatGPT Threads are never removed.
- If Cloudflare starts challenging nas, or the session needs re-pasting more than once a month, ChatGPT is dropped rather than moved to a headless browser.
