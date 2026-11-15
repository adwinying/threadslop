# threadslop

Collects T3 Code conversations from every machine, plus Adwin's Gemini and ChatGPT chats, into one searchable archive on nas, so Adwin and agents can recall past work.

## Language

**Source**:
Somewhere threadslop pulls Threads from: a Host, Gemini, or ChatGPT.
_Avoid_: Provider, origin, account

**Host**:
A Source that is a machine running T3 Code.
_Avoid_: Machine, node, client

**Gemini**:
The Source holding Adwin's chats in the gemini.google.com web app.
_Avoid_: Bard, Gemini API

**ChatGPT**:
The Source holding Adwin's chats in the chatgpt.com web app.
_Avoid_: OpenAI, ChatGPT API, Codex

**Thread**:
One conversation, identified by its Source and ID: a T3 Code thread, a Gemini chat, or a ChatGPT chat.
_Avoid_: Conversation, chat, session

**Item**:
Anything recorded in a Thread: a Message, reasoning, a tool call with its input and output, a command, a file change, the web sources a reply cites.
_Avoid_: Node, event, turn item

**Message**:
An Item holding user or assistant text.
_Avoid_: Turn, entry

**Signature**:
A Thread's latest change time, plus its Item count when its Source reports one, as last reported by its Source. A changed Signature means the Thread needs re-pulling.
_Avoid_: Checksum, version, watermark

**Sync**:
One pass that compares every Source's Signatures with the stored ones and pulls the Threads that changed.
_Avoid_: Import, backup, push

**Snapshot**:
A consistent copy of the archive written for kopia to back up.
_Avoid_: Backup, dump, export
