# Pull over forced-command SSH

The container on nas pulls from each Host over plain SSH on the tailnet. Its key is authorized on each Host with `restrict,command=` pointing at a small read-only query script installed on that Host. That gives nas only the fixed queries, never a shell.

## Considered Options

- **Push from each Host:** needs a timer and sync state on every Host, which spreads logic across machines.
- **T3 environment links or T3's protocol:** nas doesn't run T3, links expire, and protocol changes break clients (deskhud's websocket `1002`).
- **Copying `statev2.sqlite`:** files run up to 1.7GB, live WAL copies can tear, and the DB holds auth credentials.
- **Script inlined in the `command=` string:** removes the file on the Host but is hard to read and quote.
- **Plain key with the script sent over stdin:** nothing to install, but nas would get a full shell on every Host.
