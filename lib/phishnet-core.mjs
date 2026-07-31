// phish.net API access — shared by the Worker and the offline Node scripts.
// The API key is always passed in, never read from a module-level global, so this
// works both in Workers (env.PHISHNET_API_KEY) and Node (parsed from .env).

export async function phishnetGet(endpoint, apiKey) {
  const res = await fetch(`https://api.phish.net/v5${endpoint}?apikey=${apiKey}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error_message);
  return json.data;
}

export async function fetchActualSetlist(showdate, apiKey) {
  const rows = await phishnetGet(`/setlists/showdate/${showdate}.json`, apiKey);
  return rows
    .filter(r => r.artistid === 1 && r.set !== 's')
    .sort((a, b) => a.position - b.position)
    .map(r => ({ slug: r.slug, name: r.song, set: r.set }));
}
