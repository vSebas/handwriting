# Codex handwriting service

The Handwriting plugin sends selected pen ink images to this laptop service.
The service uses the **signed-in Codex CLI** to transcribe mixed prose and math
as editable Obsidian Markdown. It does not receive the note body or pasted
images. The model comes from the laptop's Codex configuration.

On Windows, install [uv](https://docs.astral.sh/uv/getting-started/installation/)
and sign in to the Codex CLI or desktop app with ChatGPT. The plugin reuses
that sign-in; it does not store ChatGPT credentials. From this repository's
root, run:

```powershell
powershell -ExecutionPolicy Bypass -File services\codex\setup.ps1
```

Keep the repository on your laptop. The desktop Handwriting plugin starts the
service when Obsidian opens. If the repository is elsewhere, set **Laptop service
folder** in Handwriting settings. **Test connection** shows the Codex model
configured on the laptop. The plugin generates an access token and saves it in
its settings. Sync that setting to iPad, or copy the token there.

On iPad, set **Laptop service URL** to `http://<laptop Wi-Fi IP>:8765` and keep
the laptop awake with desktop Obsidian open. Use the command **Transcribe all
handwriting in this note**. Review each result before inserting Markdown or
replacing its corresponding pen ink. Existing Markdown and pasted images are
preserved.
