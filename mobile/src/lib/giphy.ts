// Minimal Giphy v1 client — search + trending, mirroring renderer/chat.js
// _fetchGifs. Uses native fetch (Giphy v1 has open CORS; native fetch on RN
// has no CORS layer anyway). Caller passes the API key from
// public.user_integrations.settings.giphy.key.

export type GiphyResult = {
  id: string;
  title: string;
  // Resolved thumbnail URL for the grid preview.
  preview: string;
  // Original full GIF URL to post.
  url: string;
  // Original-size estimate (bytes); 0 when Giphy didn't surface it.
  size: number;
};

type RawImage = { url?: string; size?: string };
type RawGif = {
  id: string;
  title?: string;
  images?: {
    fixed_height_small?: RawImage;
    preview_gif?: RawImage;
    original?: RawImage;
  };
};

const BASE = 'https://api.giphy.com/v1/gifs';

export async function searchGifs(key: string, query: string, signal?: AbortSignal): Promise<GiphyResult[]> {
  if (!key) return [];
  const params = new URLSearchParams({ api_key: key, limit: '24', rating: 'g' });
  if (query) params.set('q', query);
  const url = `${BASE}/${query ? 'search' : 'trending'}?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`giphy ${res.status}`);
  const json = (await res.json()) as { data?: RawGif[] };
  return (json.data ?? []).flatMap<GiphyResult>((r) => {
    const images = r.images || {};
    const preview = images.fixed_height_small?.url || images.preview_gif?.url || images.original?.url;
    const full = images.original?.url || preview;
    if (!preview || !full) return [];
    return [{
      id: r.id,
      title: r.title || 'gif',
      preview,
      url: full,
      size: parseInt(images.original?.size || '0', 10) || 0,
    }];
  });
}
