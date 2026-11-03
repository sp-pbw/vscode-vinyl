# 🎵 Spotify Player for VSCode

<table>
<tr>
<td width="40%" valign="top">
<img src="https://raw.githubusercontent.com/meow-at-me/vscode-vinyl/main/docs/screenshot.png" alt="Spotify Player for VSCode spinning an LP in the VS Code sidebar" width="100%">
</td>
<td valign="top">

A spinning LP in your VS Code sidebar that remote-controls Spotify — play/pause, skip, seek, browse playlists, and jump between tracks while the album art spins.

> Audio plays through your normal Spotify app (desktop/web/phone); this panel is the remote + now-playing display.

**Requires Spotify Premium** and an active Spotify session somewhere (open Spotify and play once).

</td>
</tr>
</table>

---

## 🚀 Setup (one time, ~2 minutes)

Each user connects with their **own free Spotify app** (Spotify policy). It's just copy-paste, and your tokens stay on your machine.

### Step 1 — Create a Spotify app
1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app**.
3. **App name / description:** anything (e.g. `My Vinyl Player`).
4. **Redirect URI:** type this **exactly**, then click **Add**:
   ```
   http://127.0.0.1:9876/callback
   ```
   > ⚠️ Must match character-for-character. If port `9876` is taken, change **Vinyl: Redirect Port** in settings and use the matching `http://127.0.0.1:<your-port>/callback` here.
5. Under **Which API/SDKs are you planning to use?**, check **Web API**.
6. Agree to the terms and click **Save**.

### Step 2 — Copy your Client ID
1. Open your new app → **Settings** (or its main page).
2. Copy the **Client ID**.
   > 🔒 No Client Secret needed — Vinyl uses the secure PKCE flow.

### Step 3 — Paste it into VS Code
1. Open Settings: `Ctrl/Cmd + ,` → search **`vinyl`**.
2. Paste it into **Vinyl: Spotify Client Id**.
   > 💾 Settings auto-save — no Enter/Save button, just click elsewhere.

### Step 4 — Connect
1. Click the **Vinyl** icon in the Activity Bar (left edge).
2. Click **Connect Spotify** → approve in the browser. Done! 🎉

---

## 🎧 Usage

- Open the **Vinyl** icon in the Activity Bar (drag it to the panel/secondary sidebar if you like).
- Play a song from Spotify so there's an active session.
- `⏮  ⏯  ⏭` control playback; **click or drag the bar** to seek.
- **Spotify library** — click `⨁` to save the current song, or `♥` to remove it. The button checks saved status whenever the song changes and is disabled while a request is pending. Local files and non-track items cannot be saved.
- **Playlists** — open the list and click one to start playing it.
- **Tracks** — appears while playing **from a playlist**; open it to see every song and click one to jump to it.
- Command Palette: *Vinyl: Play / Pause*, *Next Track*, *Previous Track*, *Choose Playlist*, *Connect / Disconnect Spotify*.

---

## Build and local testing

Requires **Node.js 22+**, npm, and the VS Code command-line tool (`code`).

```bash
git clone https://github.com/sp-pbw/vscode-vinyl.git
cd vscode-vinyl
npm ci
npm test
npm run check-types
npx --yes @vscode/vsce@4.1.0 package --out vscode-vinyl.vsix
code --install-extension vscode-vinyl.vsix --force
```

Packaging automatically runs the production build. You can also use **Extensions > ... > Install from VSIX**. Installing with `--force` replaces an existing installed copy; reload VS Code afterward.

To run from source without installing a VSIX, run these commands from the repository directory after `npm ci`:

```bash
npm run compile
code --new-window --extensionDevelopmentPath="$PWD"
```

Use `npm run watch` while editing, then run **Developer: Reload Window** in the Extension Development Host to apply changes. Connect Spotify using the setup instructions above.

## Download automated builds

The **Build VSIX** GitHub Actions workflow runs on pushes, pull requests, and manual runs. It installs dependencies, runs the tests and type checks, builds `vscode-vinyl.vsix`, verifies its required files and metadata, and uploads it as the `vscode-vinyl` artifact. No Spotify credentials or Marketplace publishing token are required.

Open the repository's **Actions > Build VSIX**, select a successful run, and download **Artifacts > vscode-vinyl**. Extract the downloaded ZIP and install the `.vsix` using the command or VS Code menu above.

Manual **Run workflow** is available after the workflow is merged into the default branch. If GitHub Actions is disabled on your fork, enable it in the **Actions** tab first.

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `vscodeVinyl.spotifyClientId` | `""` | Your Spotify app's **Client ID** (from setup). |
| `vscodeVinyl.redirectPort` | `9876` | Loopback port for the OAuth redirect. **Must match** your app's Redirect URI. |
| `vscodeVinyl.pollIntervalMs` | `4000` | How often (ms) to refresh now-playing. |
| `vscodeVinyl.lpSkin` | `album` | Look of the record label. |

---

## 🩹 Troubleshooting

- **"No active device"** — open Spotify and play once; the panel then controls it.
- **"Playback control requires Spotify Premium"** — the control API is Premium-only.
- **Browser opened but never connected** — your Redirect URI must exactly match `http://127.0.0.1:<port>/callback` (port = `Vinyl: Redirect Port`).
- **Tracks list empty / "Forbidden"** — Spotify blocks reading its own playlists (Daily Mix, Discover Weekly, editorial, etc.). Play from a playlist **you created**.
- **Library access denied** — if you connected before library controls were added, click **Disconnect**, then **Connect Spotify** and approve again to grant `user-library-read` and `user-library-modify` permissions. Playback remains available without these permissions.

---

Tokens are stored in VS Code's encrypted Secret Storage; calls go straight to Spotify with no third-party server. **MIT License.**
