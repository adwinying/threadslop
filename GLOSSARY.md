# threadslop

Collects T3 Code conversations from every machine into one searchable archive on nas, so Adwin and agents can recall past work.

## Language

**Host**:
A machine running T3 Code that threadslop pulls conversations from.
_Avoid_: Machine, node, client

**Thread**:
One T3 Code conversation, identified by its Host and thread ID.
_Avoid_: Conversation, chat, session

**Item**:
Anything recorded in a Thread: a Message, reasoning, a tool call with its input and output, a command, a file change.
_Avoid_: Node, event, turn item

**Message**:
An Item holding user or assistant text.
_Avoid_: Turn, entry

**Signature**:
A Thread's latest change time plus its Item count, as last reported by its Host. A changed Signature means the Thread needs re-pulling.
_Avoid_: Checksum, version, watermark

**Sync**:
One pass that compares every Host's Signatures with the stored ones and pulls the Threads that changed.
_Avoid_: Import, backup, push

**Snapshot**:
A consistent copy of the archive written for kopia to back up.
_Avoid_: Backup, dump, export
