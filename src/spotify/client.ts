import { SpotifyAuth } from "./auth";
import { PlayerState, PlaylistItem, QueueTrack } from "../types";

const API = "https://api.spotify.com/v1";

/** Thrown for API-level conditions the UI should surface as a friendly notice. */
export class SpotifyNotice extends Error {}

export function isSpotifyTrackUri(uri: string | undefined): uri is string {
  return typeof uri === "string" && /^spotify:track:[A-Za-z0-9]+$/.test(uri);
}

interface RawPlayback {
  is_playing: boolean;
  progress_ms: number | null;
  repeat_state: string | null;
  device: { name: string } | null;
  context: { type: string; uri: string } | null;
  item: {
    uri: string;
    linked_from?: { uri?: string } | null;
    name: string;
    duration_ms: number;
    artists: { name: string }[];
    album: { images: { url: string; width: number }[] };
  } | null;
}

export class SpotifyClient {
  constructor(private readonly auth: SpotifyAuth) {}

  /** Low-level request with one automatic refresh+retry on 401. */
  private async request(
    path: string,
    init: RequestInit = {},
    retry = true
  ): Promise<Response> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      throw new SpotifyNotice("Not connected to Spotify.");
    }
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 && retry) {
      // Token may have just expired; force a refresh by retrying once.
      return this.request(path, init, false);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
      throw new SpotifyNotice(`Rate limited by Spotify. Retry in ${retryAfter}s.`);
    }
    if (res.status === 403) {
      if (path.startsWith("/me/library")) {
        throw new SpotifyNotice(
          "Spotify library access was denied. Disconnect and reconnect Spotify to grant library permissions."
        );
      }
      // 403 means different things by endpoint: on player control it's the Premium
      // requirement; on reads (playlists, etc.) it's forbidden — surface Spotify's reason.
      if (path.startsWith("/me/player")) {
        throw new SpotifyNotice("Playback control requires Spotify Premium.");
      }
      const detail = await res
        .json()
        .then((d) => (d && d.error && d.error.message) || "")
        .catch(() => "");
      throw new SpotifyNotice(`Forbidden 403${detail ? ": " + detail : ""}`);
    }
    return res;
  }

  /** Fetch the current playback state. Never throws for the empty/no-device cases. */
  async getPlaybackState(): Promise<PlayerState> {
    const loggedIn = await this.auth.isLoggedIn();
    if (!loggedIn) {
      return { loggedIn: false, isPlaying: false, hasTrack: false };
    }
    let res: Response;
    try {
      res = await this.request("/me/player");
    } catch (e) {
      if (e instanceof SpotifyNotice) {
        return { loggedIn: true, isPlaying: false, hasTrack: false, notice: e.message };
      }
      throw e;
    }

    // 204 = nothing playing / no active device.
    if (res.status === 204) {
      return {
        loggedIn: true,
        isPlaying: false,
        hasTrack: false,
        notice: "No active device. Open Spotify and play something.",
      };
    }
    if (!res.ok) {
      return { loggedIn: true, isPlaying: false, hasTrack: false, notice: `Spotify error ${res.status}` };
    }

    const data = (await res.json()) as RawPlayback;
    if (!data || !data.item) {
      return { loggedIn: true, isPlaying: false, hasTrack: false, notice: "Nothing playing." };
    }
    const images = data.item.album.images ?? [];
    const originalUri = data.item.linked_from?.uri;
    // Prefer a mid-size image for a crisp label.
    const art = images.find((i) => i.width && i.width <= 300)?.url ?? images[0]?.url;
    return {
      loggedIn: true,
      isPlaying: data.is_playing,
      hasTrack: true,
      track: data.item.name,
      artist: data.item.artists.map((a) => a.name).join(", "),
      albumArt: art,
      progressMs: data.progress_ms ?? 0,
      durationMs: data.item.duration_ms,
      deviceName: data.device?.name,
      repeatState: data.repeat_state ?? "off",
      trackUri: data.item.uri,
      libraryTrackUri: isSpotifyTrackUri(originalUri) ? originalUri : data.item.uri,
      contextUri: data.context?.uri,
      contextType: data.context?.type,
    };
  }

  private async control(method: string, path: string, body?: unknown): Promise<void> {
    const res = await this.request(path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      throw new SpotifyNotice("No active device. Open Spotify and play something first.");
    }
    if (!res.ok && res.status !== 204) {
      throw new SpotifyNotice(`Spotify command failed (${res.status}).`);
    }
  }

  play(): Promise<void> {
    return this.control("PUT", "/me/player/play");
  }
  pause(): Promise<void> {
    return this.control("PUT", "/me/player/pause");
  }
  next(): Promise<void> {
    return this.control("POST", "/me/player/next");
  }
  previous(): Promise<void> {
    return this.control("POST", "/me/player/previous");
  }
  seek(positionMs: number): Promise<void> {
    const ms = Math.max(0, Math.round(positionMs));
    return this.control("PUT", `/me/player/seek?position_ms=${ms}`);
  }
  setRepeat(state: "off" | "track" | "context"): Promise<void> {
    return this.control("PUT", `/me/player/repeat?state=${state}`);
  }

  private trackLibraryQuery(uri: string): string {
    if (!isSpotifyTrackUri(uri)) {
      throw new SpotifyNotice("Only Spotify tracks can be saved to your library.");
    }
    return `uris=${encodeURIComponent(uri)}`;
  }

  async isTrackSaved(uri: string): Promise<boolean> {
    const res = await this.request(`/me/library/contains?${this.trackLibraryQuery(uri)}`);
    if (!res.ok) {
      throw new SpotifyNotice(`Could not check the Spotify library (${res.status}).`);
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data) || data.length !== 1 || typeof data[0] !== "boolean") {
      throw new SpotifyNotice("Spotify returned an invalid library status.");
    }
    return data[0];
  }

  async setTrackSaved(uri: string, saved: boolean): Promise<void> {
    const res = await this.request(`/me/library?${this.trackLibraryQuery(uri)}`, {
      method: saved ? "PUT" : "DELETE",
    });
    if (!res.ok) {
      throw new SpotifyNotice(`Could not ${saved ? "save" : "remove"} the track (${res.status}).`);
    }
  }

  playContext(contextUri: string): Promise<void> {
    return this.control("PUT", "/me/player/play", { context_uri: contextUri });
  }
  /** Start playback at a specific track within a context (keeps the playlist queue intact). */
  playTrackInContext(contextUri: string, trackUri: string): Promise<void> {
    return this.control("PUT", "/me/player/play", {
      context_uri: contextUri,
      offset: { uri: trackUri },
    });
  }

  /** Fetch the tracks of a playlist context (paginated) so the user can jump within it. */
  async getPlaylistTracks(contextUri: string): Promise<{ name: string; tracks: QueueTrack[] }> {
    const id = this.contextId(contextUri, "playlist");
    if (!id) {
      throw new SpotifyNotice("Queue is only available for playlists.");
    }

    let name = "Playlist";
    const meta = await this.request(`/playlists/${id}?fields=name`);
    if (meta.ok) {
      name = ((await meta.json()) as { name?: string }).name ?? name;
    }

    // Spotify deprecated GET /playlists/{id}/tracks (403 for development-mode apps as of the
    // 2026 migration); /items is the current endpoint. Try modern first, fall back to legacy.
    let lastError: unknown;
    for (const base of [`/playlists/${id}/items`, `/playlists/${id}/tracks`]) {
      try {
        return { name, tracks: await this.collectPlaylistItems(base) };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new SpotifyNotice("Could not load the playlist queue.");
  }

  /** Walk a playlist's item pages, tolerating both the new (`item`) and legacy (`track`) shapes. */
  private async collectPlaylistItems(base: string): Promise<QueueTrack[]> {
    type RawTrack = { uri?: string; name?: string; artists?: { name: string }[] };
    const tracks: QueueTrack[] = [];
    let path: string | null = `${base}?limit=100`;
    while (path && tracks.length < 500) {
      const res: Response = await this.request(path);
      if (!res.ok) {
        throw new SpotifyNotice(`Could not load the playlist queue (${res.status}).`);
      }
      const data = (await res.json()) as {
        next: string | null;
        items: { item?: RawTrack | null; track?: RawTrack | null }[];
      };
      for (const entry of data.items ?? []) {
        const t = entry.item ?? entry.track;
        if (t && t.uri && t.name) {
          tracks.push({
            uri: t.uri,
            name: t.name,
            artist: (t.artists ?? []).map((a) => a.name).join(", "),
          });
        }
      }
      path = data.next ? data.next.replace(API, "") : null;
    }
    return tracks;
  }

  /** Extract the id from a `spotify:<type>:<id>` URI, or undefined if the type doesn't match. */
  private contextId(uri: string | undefined, type: string): string | undefined {
    if (!uri) {
      return undefined;
    }
    const parts = uri.split(":");
    return parts.length === 3 && parts[1] === type ? parts[2] : undefined;
  }

  async getPlaylists(): Promise<PlaylistItem[]> {
    const res = await this.request("/me/playlists?limit=50");
    if (!res.ok) {
      throw new SpotifyNotice(`Could not load playlists (${res.status}).`);
    }
    const data = (await res.json()) as {
      items: {
        name: string;
        uri: string;
        images: { url: string }[];
        tracks: { total: number };
      }[];
    };
    return (data.items ?? [])
      .filter((p) => p && p.uri)
      .map((p) => ({
        name: p.name,
        uri: p.uri,
        imageUrl: p.images?.[0]?.url,
        trackCount: p.tracks?.total ?? 0,
      }));
  }
}
