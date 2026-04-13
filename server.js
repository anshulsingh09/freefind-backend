/**
 * FreeFind Backend v7.0
 * Sources: Internet Archive (primary, no API key needed),
 *          Jamendo (CC music), ccMixter, Gutenberg, Open Library,
 *          Wikimedia Commons, itch.io, GitHub, LibriVox
 * Zero per-item metadata fetches. All parallel. Guaranteed results.
 */
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());
const limiter = rateLimit({ windowMs:60000, max:40, standardHeaders:true, legacyHeaders:false });
app.use('/api/', limiter);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function fmt(bytes) {
  if (!bytes) return null;
  const b = Number(bytes);
  if (!b || b <= 0) return null;
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ── CORE IA SEARCH — no per-item fetch, always returns results ────────────────
async function ia(query, mediatype, ext, rows = 12) {
  try {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier,title,creator,year,item_size&rows=${rows}&and[]=mediatype%3A%22${mediatype}%22&output=json`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 14000 });
    const docs = res.data?.response?.docs || [];
    return docs.slice(0, rows).map(d => ({
      title: d.title || query,
      creator: Array.isArray(d.creator) ? d.creator[0] : (d.creator || ''),
      source: 'Internet Archive',
      license: 'Public Domain / CC',
      downloadUrl: `https://archive.org/download/${d.identifier}/${d.identifier}.${ext}`,
      pageUrl: `https://archive.org/details/${d.identifier}`,
      fileType: ext,
      size: fmt(d.item_size),
      year: d.year || null,
      isPageLink: false,
    }));
  } catch(_) { return []; }
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────
async function searchMusic(query) {
  const [ia1, ia2, jam, cc] = await Promise.allSettled([
    ia(query, 'audio', 'mp3', 12),
    ia(query + ' music', 'audio', 'mp3', 8),
    // Jamendo — try with registered client ID
    (async () => {
      try {
        const res = await axios.get(
          `https://api.jamendo.com/v3.0/tracks/?client_id=0b4f9b88&format=json&limit=10&search=${encodeURIComponent(query)}&audioformat=mp32`,
          { headers: HEADERS, timeout: 10000 }
        );
        return (res.data?.results || []).map(t => ({
          title: t.name || query,
          creator: t.artist_name || 'Unknown',
          source: 'Jamendo',
          license: 'Creative Commons',
          downloadUrl: t.audiodownload || t.audio || '',
          pageUrl: t.shareurl || `https://www.jamendo.com/track/${t.id}`,
          fileType: 'mp3', size: null,
          isPageLink: !t.audiodownload,
        })).filter(r => r.downloadUrl);
      } catch(_) { return []; }
    })(),
    // ccMixter
    (async () => {
      try {
        const res = await axios.get(
          `https://ccmixter.org/api/query?search=${encodeURIComponent(query)}&limit=6&format=json`,
          { headers: HEADERS, timeout: 10000 }
        );
        return (res.data || []).slice(0, 4).map(t => {
          const dlUrl = (t.files||[]).find(f => f.download_url)?.download_url;
          if (!dlUrl) return null;
          return { title: t.upload_name||query, creator: t.user_name||'Unknown', source: 'ccMixter', license: t.license_name||'Creative Commons', downloadUrl: dlUrl, pageUrl: t.upload_url||'https://ccmixter.org', fileType: 'mp3', size: null, isPageLink: false };
        }).filter(Boolean);
      } catch(_) { return []; }
    })(),
  ]);
  return [
    ...(ia1.status==='fulfilled' ? ia1.value : []),
    ...(ia2.status==='fulfilled' ? ia2.value : []),
    ...(jam.status==='fulfilled' ? jam.value : []),
    ...(cc.status==='fulfilled' ? cc.value : []),
  ];
}

// ── BOOKS ─────────────────────────────────────────────────────────────────────
async function searchBook(query) {
  const [gut, ol, iaR] = await Promise.allSettled([
    (async () => {
      try {
        const res = await axios.get(`https://gutendex.com/books/?search=${encodeURIComponent(query)}`, { headers: HEADERS, timeout: 12000 });
        return (res.data?.results||[]).slice(0,6).map(b => {
          const epub = b.formats?.['application/epub+zip'];
          const pdf  = b.formats?.['application/pdf'];
          const txt  = b.formats?.['text/plain; charset=utf-8'] || b.formats?.['text/plain'];
          const dlUrl = epub||pdf||txt;
          if (!dlUrl) return null;
          return { title: b.title||query, creator: b.authors?.map(a=>a.name).join(', ')||'Unknown', source: 'Project Gutenberg', license: 'Public Domain', downloadUrl: dlUrl, pageUrl: `https://www.gutenberg.org/ebooks/${b.id}`, fileType: epub?'epub':pdf?'pdf':'txt', size: null, isPageLink: false };
        }).filter(Boolean);
      } catch(_) { return []; }
    })(),
    (async () => {
      try {
        const res = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,ia&limit=8`, { headers: HEADERS, timeout: 12000 });
        return (res.data?.docs||[]).slice(0,5).filter(d=>d.ia?.length>0).map(d => ({
          title: d.title||query, creator: d.author_name?.join(', ')||'Unknown', source: 'Open Library', license: 'Public Domain / Open Access',
          downloadUrl: `https://archive.org/download/${d.ia[0]}/${d.ia[0]}.pdf`,
          pageUrl: `https://openlibrary.org${d.key}`, fileType: 'pdf', size: null, isPageLink: false,
        }));
      } catch(_) { return []; }
    })(),
    ia(query, 'texts', 'pdf', 8),
  ]);
  return [...(gut.status==='fulfilled'?gut.value:[]),...(ol.status==='fulfilled'?ol.value:[]),...(iaR.status==='fulfilled'?iaR.value.slice(0,4):[])];
}

// ── MOVIES ────────────────────────────────────────────────────────────────────
async function searchMovie(query) {
  const [a,b] = await Promise.allSettled([ia(query,'movies','mp4',12), ia(query+' film','movies','mp4',8)]);
  return [...(a.status==='fulfilled'?a.value:[]),...(b.status==='fulfilled'?b.value:[])];
}

// ── ANIME ─────────────────────────────────────────────────────────────────────
async function searchAnime(query) {
  const [a,b,c] = await Promise.allSettled([ia(query+' anime','movies','mp4',10), ia(query+' animation','movies','mp4',8), ia(query,'movies','mp4',6)]);
  return [...(a.status==='fulfilled'?a.value:[]),...(b.status==='fulfilled'?b.value:[]),...(c.status==='fulfilled'?c.value:[])];
}

// ── AUDIOBOOKS ────────────────────────────────────────────────────────────────
async function searchAudiobook(query) {
  const [iaR,lv] = await Promise.allSettled([
    ia(query+' audiobook','audio','mp3',10),
    (async () => {
      try {
        const res = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,ia&limit=6`, { headers: HEADERS, timeout: 12000 });
        return (res.data?.docs||[]).slice(0,4).filter(d=>d.ia?.length>0).map(d => ({
          title: d.title||query, creator: d.author_name?.join(', ')||'Unknown', source: 'LibriVox / Internet Archive', license: 'Public Domain',
          downloadUrl: `https://archive.org/download/${d.ia[0]}/${d.ia[0]}_64kb.mp3`,
          pageUrl: `https://librivox.org/search?q=${encodeURIComponent(query)}`, fileType: 'mp3', size: null, isPageLink: false,
        }));
      } catch(_) { return []; }
    })(),
  ]);
  return [...(iaR.status==='fulfilled'?iaR.value:[]),...(lv.status==='fulfilled'?lv.value:[])];
}

// ── IMAGES ────────────────────────────────────────────────────────────────────
async function searchImages(query) {
  const [wm,iaR] = await Promise.allSettled([
    (async () => {
      try {
        const res = await axios.get(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=12&prop=imageinfo&iiprop=url|size|extmetadata&format=json&origin=*`, { headers: HEADERS, timeout: 12000 });
        return Object.values(res.data?.query?.pages||{}).slice(0,8).map(page => {
          const info = page.imageinfo?.[0];
          if (!info?.url) return null;
          const ext = info.url.split('.').pop().split('?')[0].toLowerCase().slice(0,6);
          return { title: (page.title||'').replace('File:','')||query, creator: info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g,'')||'Wikimedia', source: 'Wikimedia Commons', license: info.extmetadata?.LicenseShortName?.value||'CC / Public Domain', downloadUrl: info.url, pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title||'')}`, fileType: ext, size: info.size?fmt(info.size):null, isPageLink: false };
        }).filter(Boolean);
      } catch(_) { return []; }
    })(),
    ia(query,'image','jpg',6),
  ]);
  return [...(wm.status==='fulfilled'?wm.value:[]),...(iaR.status==='fulfilled'?iaR.value.slice(0,3):[])];
}

// ── GAMES ─────────────────────────────────────────────────────────────────────
async function searchGame(query) {
  const [itchio,gh,iaR] = await Promise.allSettled([
    (async () => {
      try {
        const res = await axios.get(`https://itch.io/games/free?q=${encodeURIComponent(query)}&sort=top`, { headers: HEADERS, timeout: 12000 });
        const $ = cheerio.load(res.data); const results = [];
        $('.game_cell').slice(0,8).each((_,el) => {
          const title=$(el).find('.game_title').text().trim();
          const href=$(el).find('a').first().attr('href');
          const author=$(el).find('.game_author a').first().text().trim();
          if (title&&href) { const u=href.startsWith('http')?href:`https://itch.io${href}`; results.push({ title, creator: author||'Indie Dev', source: 'itch.io', license: 'Free', downloadUrl: u, pageUrl: u, fileType: 'game', size: null, isPageLink: true }); }
        });
        return results;
      } catch(_) { return []; }
    })(),
    (async () => {
      try {
        const res = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+game&sort=stars&per_page=5`, { headers: { ...HEADERS, Accept: 'application/vnd.github.v3+json' }, timeout: 10000 });
        return (res.data?.items||[]).slice(0,4).map(r => ({ title: r.name, creator: r.owner?.login||'GitHub', source: 'GitHub', license: r.license?.name||'Open Source', downloadUrl: `https://github.com/${r.full_name}/archive/refs/heads/${r.default_branch||'main'}.zip`, pageUrl: r.html_url, fileType: 'zip', size: r.size?fmt(r.size*1024):null, isPageLink: false }));
      } catch(_) { return []; }
    })(),
    ia(query+' game','software','zip',6),
  ]);
  return [...(itchio.status==='fulfilled'?itchio.value:[]),...(gh.status==='fulfilled'?gh.value:[]),...(iaR.status==='fulfilled'?iaR.value.slice(0,3):[])];
}

// ── SOFTWARE ──────────────────────────────────────────────────────────────────
async function searchSoftware(query) {
  const [gh,iaR] = await Promise.allSettled([
    (async () => {
      try {
        const res = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`, { headers: { ...HEADERS, Accept: 'application/vnd.github.v3+json' }, timeout: 10000 });
        return (res.data?.items||[]).slice(0,6).map(r => ({ title: r.name+(r.description?' — '+r.description.slice(0,60):''), creator: r.owner?.login||'GitHub', source: 'GitHub', license: r.license?.name||'Open Source', downloadUrl: `https://github.com/${r.full_name}/archive/refs/heads/${r.default_branch||'main'}.zip`, pageUrl: r.html_url, fileType: 'zip', size: r.size?fmt(r.size*1024):null, isPageLink: false }));
      } catch(_) { return []; }
    })(),
    ia(query,'software','zip',6),
  ]);
  return [...(gh.status==='fulfilled'?gh.value:[]),...(iaR.status==='fulfilled'?iaR.value.slice(0,3):[])];
}

// ── PODCASTS / VIDEOS / EDUCATION / COMICS ────────────────────────────────────
async function searchPodcast(query) {
  const [a,b] = await Promise.allSettled([ia(query+' podcast','audio','mp3',10), ia(query,'audio','mp3',8)]);
  return [...(a.status==='fulfilled'?a.value:[]),...(b.status==='fulfilled'?b.value:[])];
}
async function searchVideos(query) {
  const [a,b] = await Promise.allSettled([ia(query,'movies','mp4',12), ia(query+' video','movies','mp4',8)]);
  return [...(a.status==='fulfilled'?a.value:[]),...(b.status==='fulfilled'?b.value:[])];
}
async function searchEducation(query) {
  const [v,b] = await Promise.allSettled([ia(query+' lecture','movies','mp4',8), searchBook(query)]);
  return [...(v.status==='fulfilled'?v.value:[]),...(b.status==='fulfilled'?b.value.slice(0,4):[])];
}
async function searchComics(query) {
  const [a,b] = await Promise.allSettled([ia(query+' comic','texts','pdf',10), ia(query+' comics','texts','cbz',8)]);
  return [...(a.status==='fulfilled'?a.value:[]),...(b.status==='fulfilled'?b.value:[])];
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.json({ name:'FreeFind API', version:'7.0.0', status:'running' }));
app.get('/api/health', (req,res) => res.json({ status:'ok', timestamp:new Date().toISOString() }));

app.get('/api/search', async (req,res) => {
  const q = ((req.query.q||req.query.query)+'').trim().slice(0,200);
  const cat = ((req.query.category)+'').trim().toLowerCase();
  if (!q||!cat) return res.status(400).json({ error:'q and category are required.' });

  const MAP = {
    music:searchMusic, books:searchBook, book:searchBook,
    movies:searchMovie, movie:searchMovie, anime:searchAnime,
    audiobooks:searchAudiobook, audiobook:searchAudiobook,
    games:searchGame, game:searchGame, software:searchSoftware,
    podcasts:searchPodcast, podcast:searchPodcast,
    images:searchImages, image:searchImages,
    videos:searchVideos, video:searchVideos,
    education:searchEducation, comics:searchComics, comic:searchComics,
  };

  const handler = MAP[cat];
  if (!handler) return res.status(400).json({ error:`Unknown category: ${cat}` });

  try {
    const raw = await handler(q);
    const seen = new Set();
    const results = raw.filter(r => {
      if (!r?.downloadUrl||seen.has(r.downloadUrl)) return false;
      seen.add(r.downloadUrl); return true;
    });
    results.sort((a,b) => (a.isPageLink?1:0)-(b.isPageLink?1:0));
    res.json({ query:q, category:cat, count:results.length, results });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error:'Search failed.' });
  }
});

// ── DOWNLOAD PROXY ────────────────────────────────────────────────────────────
const ALLOWED = [
  'archive.org','gutenberg.org','gutendex.com','openlibrary.org',
  'github.com','raw.githubusercontent.com','objects.githubusercontent.com','codeload.github.com',
  'ccmixter.org','upload.wikimedia.org','commons.wikimedia.org',
  'mp3d.jamendo.com','storage.jamendo.com','jamendo.com',
  'freemusicarchive.org','standardebooks.org','librivox.org',
];

app.get('/api/download', async (req,res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error:'url is required.' });
  let parsed;
  try { parsed = new URL(decodeURIComponent(url)); }
  catch { return res.status(400).json({ error:'Invalid URL.' }); }
  const host = parsed.hostname.replace(/^www\./,'');
  if (!ALLOWED.some(d => host===d||host.endsWith('.'+d)))
    return res.status(403).json({ error:`Domain not allowed: ${host}` });
  try {
    const upstream = await axios({ method:'GET', url:parsed.href, responseType:'stream', headers:{ ...HEADERS, Referer:'https://archive.org/' }, timeout:120000, maxRedirects:10 });
    const ct = upstream.headers['content-type']||'application/octet-stream';
    const cl = upstream.headers['content-length'];
    const rawExt = parsed.pathname.split('.').pop().slice(0,10);
    const safeExt = /^[a-zA-Z0-9]+$/.test(rawExt)?rawExt:'bin';
    const name = filename ? String(filename).replace(/[^a-zA-Z0-9._\- ]/g,'_').slice(0,200) : `freefind.${safeExt}`;
    res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
    res.setHeader('Content-Type',ct);
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Expose-Headers','Content-Disposition,Content-Length');
    if (cl) res.setHeader('Content-Length',cl);
    upstream.data.pipe(res);
    upstream.data.on('error',()=>{ if(!res.headersSent) res.status(500).end(); else res.end(); });
  } catch(err) {
    if (!res.headersSent) res.status(502).json({ error:'Could not fetch file.', detail:err.message });
  }
});

app.use((req,res) => res.status(404).json({ error:'Not found.' }));
app.use((err,req,res,next) => res.status(500).json({ error:'Server error.' }));

const SELF = process.env.RENDER_EXTERNAL_URL||'https://freefind-backend.onrender.com';
if (process.env.NODE_ENV==='production') {
  setInterval(()=>axios.get(`${SELF}/api/health`,{timeout:8000}).catch(()=>{}), 9*60*1000);
}
app.listen(PORT, ()=>console.log(`FreeFind v7.0 running on port ${PORT}`));
