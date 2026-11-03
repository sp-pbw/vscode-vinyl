# Changelog

## [Unreleased]

- Save or remove the current song from your Spotify library using the `⨁` / `♥` control, with saved status checked on track changes.
- Request Spotify library read/modify permissions; previously connected users must disconnect and reconnect once.
- Build and upload installable VSIX artifacts with GitHub Actions on pushes, pull requests, and manual runs.

## [0.0.4] - 2026-07-27

- Renamed the extension to "Spotify Player for VSCode".
- Use the editor's own UI font (`--vscode-font-family`/`-size`/`-weight`) instead of the bundled pixel fonts; the `Jersey10`/`Micro5` `.ttf` assets are gone.
- New repeat button, cycling off → repeat all → repeat one.
- Previous button now restarts the current track when more than 3s in, like a normal music app.

## [0.0.1] - 2026-06-20

Initial release.

- Pixel-art spinning LP record view in the Activity Bar.
- Spotify OAuth (Authorization Code + PKCE, bring-your-own Client ID, loopback redirect).
- Playback controls: play / pause / next / previous.
- Now-playing display: album art on the record label, track/artist, progress bar; spin syncs to play state.
- Playlist browser — start any of your Spotify playlists.
- Command Palette commands for all actions.
