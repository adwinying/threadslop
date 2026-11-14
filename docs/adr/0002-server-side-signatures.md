# Server-side Signatures instead of a watermark

nas stores, per Thread, the Signature its Host last reported (latest change time plus item count), and re-pulls a Thread when the Host reports a different one. A global "changed since" timestamp would miss forks and legacy imports, which write items with old timestamps, and the count catches those. Comparing against the last _reported_ Signature rather than nas's own rows means Hosts keep no state and a lost POST simply retries next Sync.
