import * as vscode from "vscode";
import * as http from "http";
import * as crypto from "crypto";

const TOKEN_KEY = "vscodeVinyl.spotifyTokens";
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class SpotifyAuth {
  private readonly _onDidChange = new vscode.EventEmitter<boolean>();
  /** Fires with the new logged-in state whenever auth status changes. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get clientId(): string {
    return vscode.workspace.getConfiguration("vscodeVinyl").get<string>("spotifyClientId", "").trim();
  }

  private get redirectPort(): number {
    return vscode.workspace.getConfiguration("vscodeVinyl").get<number>("redirectPort", 9876);
  }

  private get redirectUri(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.readTokens()) !== undefined;
  }

  private async readTokens(): Promise<StoredTokens | undefined> {
    const raw = await this.context.secrets.get(TOKEN_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return undefined;
    }
  }

  private async writeTokens(t: StoredTokens): Promise<void> {
    await this.context.secrets.store(TOKEN_KEY, JSON.stringify(t));
  }

  async logout(): Promise<void> {
    await this.context.secrets.delete(TOKEN_KEY);
    this._onDidChange.fire(false);
  }

  /** Runs the full PKCE authorization-code flow. Throws on failure. */
  async login(): Promise<void> {
    const clientId = this.clientId;
    if (!clientId) {
      const pick = await vscode.window.showErrorMessage(
        "Set your Spotify Client ID first (Settings → Vinyl).",
        "Open Settings",
        "Open Spotify Dashboard"
      );
      if (pick === "Open Settings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "vscodeVinyl.spotifyClientId");
      } else if (pick === "Open Spotify Dashboard") {
        await vscode.env.openExternal(vscode.Uri.parse("https://developer.spotify.com/dashboard"));
      }
      throw new Error("Missing Spotify Client ID");
    }

    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    const code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Connecting to Spotify…", cancellable: true },
      (_progress, cancelToken) => this.captureAuthCode(clientId, challenge, state, cancelToken)
    );

    const tokens = await this.exchangeCode(clientId, code, verifier);
    await this.writeTokens(tokens);
    this._onDidChange.fire(true);
    vscode.window.showInformationMessage("Spotify connected 🎵");
  }

  /** Starts a one-shot loopback server, opens the browser, resolves with the auth code. */
  private captureAuthCode(
    clientId: string,
    challenge: string,
    state: string,
    cancelToken: vscode.CancellationToken
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.redirectPort}`);
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end();
            return;
          }
          const returnedState = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const code = url.searchParams.get("code");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#191414;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${
              error ? "Spotify connection failed" : "Spotify connected 🎵"
            }</h2><p>You can close this tab and return to VS Code.</p></div></body>`
          );
          cleanup();
          if (error) {
            reject(new Error(`Spotify authorization error: ${error}`));
          } else if (returnedState !== state) {
            reject(new Error("State mismatch during Spotify authorization."));
          } else if (!code) {
            reject(new Error("No authorization code returned by Spotify."));
          } else {
            resolve(code);
          }
        } catch (e) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      const cleanup = () => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      };

      cancelToken.onCancellationRequested(() => {
        cleanup();
        reject(new Error("Spotify connection cancelled."));
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${this.redirectPort} is in use. Change "vscodeVinyl.redirectPort" (and your Spotify app's redirect URI) and try again.`
            )
          );
        } else {
          reject(err);
        }
      });

      server.listen(this.redirectPort, "127.0.0.1", () => {
        const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("redirect_uri", this.redirectUri);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("code_challenge", challenge);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", SCOPES);
        void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
      });
    });
  }

  private async exchangeCode(clientId: string, code: string, verifier: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
  }

  private async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: this.clientId,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (res.status === 400 || res.status === 401) {
      // Refresh token no longer valid -> force re-login.
      await this.logout();
      throw new Error("Spotify session expired. Please reconnect.");
    }
    if (!res.ok) {
      throw new Error(`Token refresh failed (${res.status})`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const updated: StoredTokens = {
      accessToken: json.access_token,
      // Spotify may or may not return a new refresh token.
      refreshToken: json.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    await this.writeTokens(updated);
    return updated;
  }

  /** Returns a valid access token, refreshing if needed. Returns undefined when logged out. */
  async getAccessToken(): Promise<string | undefined> {
    let tokens = await this.readTokens();
    if (!tokens) {
      return undefined;
    }
    // Refresh ~30s before expiry.
    if (Date.now() >= tokens.expiresAt - 30_000) {
      tokens = await this.refresh(tokens);
    }
    return tokens.accessToken;
  }
}
