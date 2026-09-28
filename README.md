# Microsoft session cookie class — sandbox note

**Ayodapo Adesiyan** (`dapslegend`)

I write PoCs of wild bugs in the wild. This repo is the **sandbox note** for one class: Microsoft / Entra session cookies and OAuth refresh tokens stolen outside the browser, then replayed to read mail.

The old README walked through app registration, mail scopes, token files, and a Telegram ping. That is a grabber, not a proof. Those steps are withdrawn from this README. Do not follow deleted instructions from git history.

## The wild bug

A user completes a normal Microsoft login. Something else on the box — a local process, a malicious extension, or a phish that lands a token on disk — copies the session cookie or the refresh token. The copy is enough to call Graph as that user: read mail, sometimes send mail, until the session is revoked.

What I look for when I write the PoC:

- Token or cookie material at rest outside the browser profile (a json file, a log, a pasted redirect).
- A second client that can call `https://graph.microsoft.com/v1.0/me` with that material **without** the user present.
- No malware required to explain the class. The bug is "bearer secret equals the user."

## Sandbox rules

- Use a tenant and a test user you own.
- Consent only `User.Read` if you must prove identity. Do not request `Mail.Read`, `Mail.Send`, or `offline_access` for a public demo.
- Keep tokens in memory for the length of the test. Do not write `tokens.json`. Do not post tokens to Telegram, Discord, or a paste site.
- Revoke the session in Entra when the test ends (revoke sign-in sessions, remove the refresh token).

## Closure

- Conditional access and token protection so a stolen refresh token from another device is rejected.
- No long-lived refresh tokens for public clients that do not need offline access.
- Secrets never in git, never in a world-readable file, never in a chat bot.
- A fix is "replay from a second machine fails," not "the README got shorter."

## Status of the code in this repo

Treat `server.js`, templates, and token guides as **unmaintained and unsafe to run**. This README is the supported document. I am not publishing a cookie sandbox that reads or sends someone else's mail.

Authorized testing on accounts you own only.
