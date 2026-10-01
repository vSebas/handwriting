# Security

## supported version

Only the newest release of this fork (the version in `manifest.json`) is
supported.

## reporting a vulnerability

Do not open a normal issue for an exploitable defect. A public issue tells
everyone else how to use it before there is a fix.

Use GitHub private vulnerability reporting on this repository, under the
Security tab. That channel is private to the maintainer until a fix is out.

Include what you did, what happened, and what an attacker gets out of it. A
reproduction helps more than anything else.

## what belongs in the issue tracker instead

Ordinary crashes, hangs, rendering faults and data-loss bugs go in the normal
issue tracker, unless the defect crosses a security boundary. Losing your
own ink to a save bug is a serious bug, but not a vulnerability. Reading or
writing a file outside the vault, or executing something a note controls,
would be.

If you are not sure which one you have, use private reporting. It can
always be moved into the open later.

## scope

Handwriting itself makes no internet requests. The realistic surface is what
it reads and writes on disk, and what it does with content that comes from a
note or a sidecar file.

This fork adds optional Codex transcription, **off by default**. With the
feature off, no server runs and no network requests are made. Enabled on a
desktop, it hosts a bearer-token-protected HTTP bridge (plain HTTP, reachable
on the local network at the configured port) and invokes the locally
installed, signed-in Codex CLI; handwriting images leave the device only to
that laptop and from there to the user's own Codex account. The token is
stored in the plugin's `data.json`. Treat the bridge as trusted-network-only:
do not expose its port beyond networks you trust.

## no bug bounty

There is no bug-bounty program and no payment for reports.
