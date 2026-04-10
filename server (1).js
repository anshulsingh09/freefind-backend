const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
app.use('/api/', limiter);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};

function formatSize(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Shared helper: search Internet Archive and return usable download hits
async function searchIA(query, mediatype, fileExts, rows = 8) {
  const results = [];
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,creator,year&rows=${rows}&and[]=mediatype%3A%22${mediatype}%22&output=json`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.response?.docs || [];

    const fetches = docs.slice(0, 6).map(async doc => {
      try {
        const fileRes = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { headers: HEADERS, timeout: 8000 });
        const files = fileRes.data?.files || [];
        let chosen = null;
        for (const ext of fileExts) {
          chosen = files.find(f => f.name?.toLowerCase().endsWith('.' + ext));
          if (chosen) break;
        }
        if (chosen) {
          return {
            title: doc.title || query,
            creator: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ''),
            source: 'Internet Archive',
            license: 'Public Domain / CC',
            downloadUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(chosen.name)}`,
            fileType: chosen.name.split('.').pop().toLowerCase(),
            size: formatSize(chosen.size),
            year: doc.year || null,
            isPageLink: false,
          };
        }
      } catch (_) {}
      return null;
    });

    const resolved = await Promise.all(fetches);
    resolved.forEach(r => { if (r) results.push(r); });
  } catch (_) {}
  return results;
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────
async function searchMusic(query) {
  const results = [];

  const iaResults = await searchIA(query, 'audio', ['mp3', 'ogg', 'flac', 'wav'], 10);
  results.push(...iaResults);

  // ccMixter CC licensed music
  if (results.length < 4) {
    try {
      const res = await axios.get(
        `https://ccmixter.org/api/query?search=${encodeURIComponent(query)}&limit=5&format=json`,
        { headers: HEADERS, timeout: 10000 }
      );
      const tracks = res.data || [];
      for (const t of tracks.slice(0, 3)) {
        const dlUrl = t.files?.find(f => f.download_url)?.download_url;
        if (dlUrl) {
          results.push({
            title: t.upload_name || query,
            creator: t.user_name || 'Unknown',
            source: 'ccMixter',
            license: t.license_name || 'Creative Commons',
            downloadUrl: dlUrl,
            fileType: 'mp3',
            size: null,
            isPageLink: false,
          });
        }
      }
    } catch (_) {}
  }

  return results;
}

// ── BOOKS ─────────────────────────────────────────────────────────────────────
async function searchBook(query) {
  const results = [];

  // Project Gutenberg
  try {
    const res = await axios.get(`https://gutendex.com/books/?search=${encodeURIComponent(query)}`, { headers: HEADERS, timeout: 12000 });
    const books = res.data?.results || [];
    for (const b of books.slice(0, 5)) {
      const epubUrl = b.formats?.['application/epub+zip'];
      const pdfUrl = b.formats?.['application/pdf'];
      const txtUrl = b.formats?.['text/plain; charset=utf-8'] || b.formats?.['text/plain'];
      const dlUrl = epubUrl || pdfUrl || txtUrl;
      const fileType = epubUrl ? 'epub' : pdfUrl ? 'pdf' : 'txt';
      if (dlUrl) {
        results.push({
          title: b.title || query,
          creator: b.authors?.map(a => a.name).join(', ') || 'Unknown Author',
          source: 'Project Gutenberg',
          license: 'Public Domain',
          downloadUrl: dlUrl,
          fileType,
          size: null,
          isPageLink: false,
        });
      }
    }
  } catch (_) {}

  // Open Library
  try {
    const res = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,ia&limit=6`, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.docs || [];
    for (const doc of docs.slice(0, 3)) {
      if (doc.ia?.length > 0) {
        results.push({
          title: doc.title || query,
          creator: doc.author_name?.join(', ') || 'Unknown Author',
          source: 'Open Library',
          license: 'Public Domain / Open Access',
          downloadUrl: `https://archive.org/download/${doc.ia[0]}/${doc.ia[0]}.pdf`,
          fileType: 'pdf',
          size: null,
          isPageLink: false,
        });
      }
    }
  } catch (_) {}

  // Internet Archive texts
  const iaResults = await searchIA(query, 'texts', ['pdf', 'epub', 'txt'], 6);
  results.push(...iaResults.slice(0, 3));

  return results;
}

// ── MOVIES ────────────────────────────────────────────────────────────────────
async function searchMovie(query) {
  const results = [];

  const iaMovies = await searchIA(query, 'movies', ['mp4', 'ogv', 'avi', 'mkv', 'mov'], 10);
  results.push(...iaMovies);

  // Prelinger Archives (massive public domain film collection)
  if (results.length < 3) {
    try {
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+collection%3Aprelinger&fl[]=identifier,title,creator,year&rows=6&and[]=mediatype%3A%22movies%22&output=json`;
      const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
      const docs = res.data?.response?.docs || [];
      const fetches = docs.slice(0, 4).map(async doc => {
        try {
          const fileRes = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { headers: HEADERS, timeout: 8000 });
          const files = fileRes.data?.files || [];
          const vid = files.find(f => /\.(mp4|ogv|avi|mkv|mov)$/i.test(f.name));
          if (vid) {
            return {
              title: doc.title || query,
              creator: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || 'Prelinger Archives'),
              source: 'Prelinger Archives / Internet Archive',
              license: 'Public Domain',
              downloadUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(vid.name)}`,
              fileType: vid.name.split('.').pop().toLowerCase(),
              size: formatSize(vid.size),
              year: doc.year || null,
              isPageLink: false,
            };
          }
        } catch (_) {}
        return null;
      });
      const resolved = await Promise.all(fetches);
      resolved.forEach(r => { if (r) results.push(r); });
    } catch (_) {}
  }

  return results;
}

// ── ANIME ─────────────────────────────────────────────────────────────────────
async function searchAnime(query) {
  const results = [];

  const iaResults = await searchIA(`${query} anime`, 'movies', ['mp4', 'ogv', 'avi', 'mkv'], 10);
  results.push(...iaResults);

  if (results.length < 2) {
    const iaResults2 = await searchIA(query, 'movies', ['mp4', 'ogv', 'avi', 'mkv'], 8);
    results.push(...iaResults2);
  }

  // Anime soundtracks fallback
  if (results.length < 3) {
    const audioResults = await searchIA(`${query} anime soundtrack`, 'audio', ['mp3', 'ogg', 'flac'], 6);
    results.push(...audioResults);
  }

  return results;
}

// ── AUDIOBOOKS ────────────────────────────────────────────────────────────────
async function searchAudiobook(query) {
  const results = [];

  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,creator&rows=8&and[]=mediatype%3A%22audio%22&and[]=subject%3A%22audiobook%22&output=json`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.response?.docs || [];
    const fetches = docs.slice(0, 6).map(async doc => {
      try {
        const fileRes = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { headers: HEADERS, timeout: 8000 });
        const files = fileRes.data?.files || [];
        const audio = files.find(f => /\.(mp3|ogg|flac)$/i.test(f.name));
        if (audio) {
          return {
            title: doc.title || query,
            creator: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ''),
            source: 'Internet Archive',
            license: 'Public Domain / CC',
            downloadUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(audio.name)}`,
            fileType: audio.name.split('.').pop().toLowerCase(),
            size: formatSize(audio.size),
            isPageLink: false,
          };
        }
      } catch (_) {}
      return null;
    });
    const resolved = await Promise.all(fetches);
    resolved.forEach(r => { if (r) results.push(r); });
  } catch (_) {}

  // LibriVox via Open Library
  try {
    const res = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,ia&limit=5`, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.docs || [];
    for (const doc of docs.slice(0, 3)) {
      if (doc.ia?.length > 0) {
        results.push({
          title: doc.title || query,
          creator: doc.author_name?.join(', ') || 'Unknown Author',
          source: 'LibriVox / Open Library',
          license: 'Public Domain',
          downloadUrl: `https://archive.org/download/${doc.ia[0]}/${doc.ia[0]}_64kb.mp3`,
          fileType: 'mp3',
          size: null,
          isPageLink: false,
        });
      }
    }
  } catch (_) {}

  return results;
}

// ── IMAGES ────────────────────────────────────────────────────────────────────
async function searchImages(query) {
  const results = [];

  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=10&prop=imageinfo&iiprop=url|size|mediatype|extmetadata&format=json&origin=*`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const pages = res.data?.query?.pages || {};
    for (const page of Object.values(pages).slice(0, 6)) {
      const info = page.imageinfo?.[0];
      if (info?.url) {
        const license = info.extmetadata?.LicenseShortName?.value || 'CC / Public Domain';
        const author = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '') || 'Unknown';
        results.push({
          title: page.title?.replace('File:', '') || query,
          creator: author,
          source: 'Wikimedia Commons',
          license,
          downloadUrl: info.url,
          fileType: info.url.split('.').pop().split('?')[0].toLowerCase().slice(0, 6),
          size: info.size ? formatSize(info.size) : null,
          isPageLink: false,
        });
      }
    }
  } catch (_) {}

  if (results.length < 3) {
    const iaResults = await searchIA(query, 'image', ['jpg', 'jpeg', 'png', 'gif', 'tiff'], 6);
    results.push(...iaResults);
  }

  return results;
}

// ── GAMES ─────────────────────────────────────────────────────────────────────
async function searchGame(query) {
  const results = [];

  // itch.io free games
  try {
    const res = await axios.get(`https://itch.io/games/free?q=${encodeURIComponent(query)}&sort=top`, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    $('.game_cell').slice(0, 5).each((i, el) => {
      const title = $(el).find('.game_title').text().trim();
      const href = $(el).find('a').first().attr('href');
      if (title && href) {
        results.push({
          title,
          creator: $(el).find('.game_author a, .by').first().text().trim() || 'Indie Developer',
          source: 'itch.io',
          license: 'Free to Play',
          downloadUrl: href.startsWith('http') ? href : `https://itch.io${href}`,
          fileType: 'game page',
          size: null,
          isPageLink: true,
        });
      }
    });
  } catch (_) {}

  // GitHub open source games
  try {
    const res = await axios.get(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+game&sort=stars&per_page=5`,
      { headers: { ...HEADERS, Accept: 'application/vnd.github.v3+json' }, timeout: 10000 }
    );
    const repos = res.data?.items || [];
    for (const r of repos.slice(0, 3)) {
      results.push({
        title: r.name || query,
        creator: r.owner?.login || 'GitHub',
        source: 'GitHub',
        license: r.license?.name || 'Open Source',
        downloadUrl: `https://github.com/${r.full_name}/archive/refs/heads/${r.default_branch || 'main'}.zip`,
        fileType: 'zip',
        size: r.size ? formatSize(r.size * 1024) : null,
        isPageLink: false,
      });
    }
  } catch (_) {}

  // IA retro games
  const iaGames = await searchIA(query, 'software', ['zip', 'exe', 'iso', '7z'], 6);
  results.push(...iaGames.slice(0, 2));

  return results;
}

// ── SOFTWARE ──────────────────────────────────────────────────────────────────
async function searchSoftware(query) {
  const results = [];

  try {
    const res = await axios.get(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=6`,
      { headers: { ...HEADERS, Accept: 'application/vnd.github.v3+json' }, timeout: 10000 }
    );
    const repos = res.data?.items || [];
    for (const r of repos.slice(0, 5)) {
      results.push({
        title: r.full_name,
        creator: r.owner?.login || 'GitHub',
        source: 'GitHub',
        license: r.license?.name || 'Open Source',
        downloadUrl: `https://github.com/${r.full_name}/archive/refs/heads/${r.default_branch || 'main'}.zip`,
        fileType: 'zip',
        size: r.size ? formatSize(r.size * 1024) : null,
        description: r.description || null,
        isPageLink: false,
      });
    }
  } catch (_) {}

  const iaResults = await searchIA(query, 'software', ['zip', 'exe', 'iso', '7z'], 6);
  results.push(...iaResults.slice(0, 3));

  return results;
}

// ── PODCASTS ──────────────────────────────────────────────────────────────────
async function searchPodcast(query) {
  return await searchIA(query, 'audio', ['mp3', 'ogg'], 8);
}

// ── VIDEOS ────────────────────────────────────────────────────────────────────
async function searchVideos(query) {
  return await searchIA(query, 'movies', ['mp4', 'ogv', 'avi', 'mkv', 'mov'], 10);
}

// ── EDUCATION ─────────────────────────────────────────────────────────────────
async function searchEducation(query) {
  const results = [];

  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query + ' lecture OR course OR tutorial')}&fl[]=identifier,title,creator,year&rows=10&and[]=mediatype%3A%22movies%22&output=json`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.response?.docs || [];
    const fetches = docs.slice(0, 6).map(async doc => {
      try {
        const fileRes = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { headers: HEADERS, timeout: 8000 });
        const files = fileRes.data?.files || [];
        const vid = files.find(f => /\.(mp4|ogv|avi)$/i.test(f.name));
        if (vid) {
          return {
            title: doc.title || query,
            creator: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ''),
            source: 'Internet Archive',
            license: 'Public Domain / CC',
            downloadUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(vid.name)}`,
            fileType: vid.name.split('.').pop().toLowerCase(),
            size: formatSize(vid.size),
            year: doc.year || null,
            isPageLink: false,
          };
        }
      } catch (_) {}
      return null;
    });
    const resolved = await Promise.all(fetches);
    resolved.forEach(r => { if (r) results.push(r); });
  } catch (_) {}

  if (results.length < 3) {
    const bookResults = await searchBook(query);
    results.push(...bookResults.slice(0, 3));
  }

  return results;
}

// ── COMICS ────────────────────────────────────────────────────────────────────
async function searchComics(query) {
  const results = [];

  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,creator,year&rows=8&and[]=mediatype%3A%22texts%22&and[]=collection%3A%22comics%22&output=json`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const docs = res.data?.response?.docs || [];
    const fetches = docs.slice(0, 6).map(async doc => {
      try {
        const fileRes = await axios.get(`https://archive.org/metadata/${doc.identifier}`, { headers: HEADERS, timeout: 8000 });
        const files = fileRes.data?.files || [];
        const comic = files.find(f => /\.(cbz|cbr|pdf|zip)$/i.test(f.name));
        if (comic) {
          return {
            title: doc.title || query,
            creator: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ''),
            source: 'Internet Archive',
            license: 'Public Domain',
            downloadUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(comic.name)}`,
            fileType: comic.name.split('.').pop().toLowerCase(),
            size: formatSize(comic.size),
            year: doc.year || null,
            isPageLink: false,
          };
        }
      } catch (_) {}
      return null;
    });
    const resolved = await Promise.all(fetches);
    resolved.forEach(r => { if (r) results.push(r); });
  } catch (_) {}

  if (results.length < 2) {
    const iaResults = await searchIA(`${query} comic`, 'texts', ['pdf', 'cbz', 'cbr', 'zip'], 6);
    results.push(...iaResults);
  }

  return results;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ name: 'FreeFind API', status: 'running', version: '3.0.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FreeFind backend is running', timestamp: new Date().toISOString() });
});

app.get('/api/search', async (req, res) => {
  const rawQuery = req.query.q || req.query.query;
  const { category } = req.query;

  if (!rawQuery || !category) {
    return res.status(400).json({ error: 'Both q and category are required.' });
  }

  const q = String(rawQuery).trim().slice(0, 200);
  const catRaw = String(category).trim().toLowerCase();

  const CATEGORY_MAP = {
    music: 'music', books: 'book', book: 'book',
    movies: 'movie', movie: 'movie', anime: 'anime',
    audiobooks: 'audiobook', audiobook: 'audiobook',
    games: 'game', game: 'game', software: 'software',
    podcasts: 'podcast', podcast: 'podcast',
    images: 'images', image: 'images',
    videos: 'videos', video: 'videos',
    education: 'education', comics: 'comics', comic: 'comics',
  };

  const cat = CATEGORY_MAP[catRaw];
  if (!cat) {
    return res.status(400).json({ error: `Unknown category "${catRaw}".` });
  }

  try {
    let results = [];
    if (cat === 'music')     results = await searchMusic(q);
    if (cat === 'book')      results = await searchBook(q);
    if (cat === 'movie')     results = await searchMovie(q);
    if (cat === 'anime')     results = await searchAnime(q);
    if (cat === 'audiobook') results = await searchAudiobook(q);
    if (cat === 'game')      results = await searchGame(q);
    if (cat === 'software')  results = await searchSoftware(q);
    if (cat === 'podcast')   results = await searchPodcast(q);
    if (cat === 'images')    results = await searchImages(q);
    if (cat === 'videos')    results = await searchVideos(q);
    if (cat === 'education') results = await searchEducation(q);
    if (cat === 'comics')    results = await searchComics(q);

    // Deduplicate by downloadUrl
    const seen = new Set();
    const unique = results.filter(r => {
      if (!r.downloadUrl || seen.has(r.downloadUrl)) return false;
      seen.add(r.downloadUrl);
      return true;
    });

    res.json({ query: q, category: cat, count: unique.length, results: unique });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

// ── DOWNLOAD PROXY ────────────────────────────────────────────────────────────
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter is required.' });

  const ALLOWED_DOMAINS = [
    'archive.org', 'freemusicarchive.org', 'gutenberg.org',
    'gutendex.com', 'openlibrary.org', 'standardebooks.org',
    'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
    'sourceforge.net', 'ccmixter.org', 'upload.wikimedia.org', 'commons.wikimedia.org',
  ];

  let parsedHost;
  try {
    parsedHost = new URL(decodeURIComponent(url)).hostname.replace(/^www\./, '');
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const isAllowed = ALLOWED_DOMAINS.some(d => parsedHost === d || parsedHost.endsWith('.' + d));
  if (!isAllowed) {
    return res.status(403).json({ error: `Domain "${parsedHost}" is not allowed.` });
  }

  try {
    const upstream = await axios({
      method: 'GET',
      url: decodeURIComponent(url),
      responseType: 'stream',
      headers: HEADERS,
      timeout: 120000,
      maxRedirects: 10,
    });

    const contentType = upstream.headers['content-type'] || 'application/octet-stream';
    const contentLength = upstream.headers['content-length'];
    const rawExt = decodeURIComponent(url).split('?')[0].split('.').pop().slice(0, 10);
    const safeExt = /^[a-zA-Z0-9]+$/.test(rawExt) ? rawExt : 'bin';
    const safeName = filename
      ? String(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 200)
      : `freefind-download.${safeExt}`;

    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.data.pipe(res);
    upstream.data.on('error', err => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed.' });
      else res.end();
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch file.', detail: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// Keep Render free tier awake
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://freefind-backend.onrender.com';
if (process.env.NODE_ENV === 'production') {
  setInterval(() => {
    axios.get(`${SELF_URL}/api/health`, { timeout: 10000 }).catch(() => {});
  }, 10 * 60 * 1000);
  console.log('Keep-alive ping enabled');
}

app.listen(PORT, () => console.log(`FreeFind backend running on port ${PORT}`));
