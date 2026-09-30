# Codex handwriting bridge

Install Codex CLI on the laptop and sign in with ChatGPT. The Handwriting plugin
uses the same Codex installation and sign-in as Claudian. Desktop Obsidian hosts
the token-protected iPad bridge directly; Python, uv, a repository checkout, and
setup scripts are no longer required.

Open Handwriting settings on the laptop and select **Test connection**. This
also starts the bridge and generates its access token. On iPad, set **Laptop
service URL** to `http://<laptop Wi-Fi IP>:8765` and sync or copy the access
token. Keep the laptop awake with desktop Obsidian open.

The **Transcription model** dropdown follows the laptop's Codex model by
default. It loads image-capable model choices from the laptop's Codex CLI,
including on iPad; use the refresh button if the list changes. A model chosen
on iPad is sent with its transcription request. The list is a catalog, so a
successful transcription confirms access to the selected model.

Use **Transcribe all handwriting in this note** or the lasso transcription
command. Review each result before inserting Markdown or replacing ink.
Existing Markdown and pasted images are preserved.
