const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/textures', express.static('output/textures'));

// ── Static data ───────────────────────────────────────────────────────────
let recipesDB = {};
let recipesIndex = { by_type: {}, by_namespace: {} };
let itemTextures = {};

const recipesDbPath = path.join(__dirname, 'output', 'recipes_db.json');
const recipesIndexPath = path.join(__dirname, 'output', 'recipes_index.json');
const itemTexturesPath = path.join(__dirname, 'output', 'item_textures.json');

try {
  if (fs.existsSync(recipesDbPath)) recipesDB = JSON.parse(fs.readFileSync(recipesDbPath, 'utf-8'));
} catch (e) { console.error('[Server] Error loading recipes_db.json:', e.message); }

try {
  if (fs.existsSync(recipesIndexPath)) recipesIndex = JSON.parse(fs.readFileSync(recipesIndexPath, 'utf-8'));
} catch (e) { console.error('[Server] Error loading recipes_index.json:', e.message); }

try {
  if (fs.existsSync(itemTexturesPath)) itemTextures = JSON.parse(fs.readFileSync(itemTexturesPath, 'utf-8'));
} catch (e) { console.error('[Server] Error loading item_textures.json:', e.message); }

// ── Persistent: custom recipes ────────────────────────────────────────────
const CUSTOM_FILE = path.join(__dirname, 'custom_recipes.json');
let customRecipes = {};
try { if (fs.existsSync(CUSTOM_FILE)) customRecipes = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf-8')); } catch {}
const saveCustom = () => { try { fs.writeFileSync(CUSTOM_FILE, JSON.stringify(customRecipes, null, 2)); } catch {} };

// ── Persistent: craft log ─────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'craft_log.json');
let craftLog = [];
try { if (fs.existsSync(LOG_FILE)) craftLog = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch {}
const saveLog = () => { try { fs.writeFileSync(LOG_FILE, JSON.stringify(craftLog.slice(-500), null, 2)); } catch {} };

// ── Live state ────────────────────────────────────────────────────────────
let liveInventory      = null;
let lastInventoryUpdate = null;
let craftingQueue      = [];
let queueIdCounter     = 1;

// ── SSE clients ───────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('retry: 1000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

console.log(`Loaded ${Object.keys(recipesDB).length} recipes, ${Object.keys(itemTextures).length} textures, ${Object.keys(customRecipes).length} custom`);

// ── Items ─────────────────────────────────────────────────────────────────
app.get('/api/items', (req, res) => {
  try {
    const search = (req.query.search || '').toLowerCase();
    const ns     = req.query.namespace || '';
    const items  = new Map();

    // built-in recipes
    for (const [, recipe] of Object.entries(recipesDB)) {
      try {
        const data = recipe.data;
        let ri = null;
        if (data.result)      ri = typeof data.result  === 'string' ? data.result  : (data.result.item  || data.result.id);
        else if (data.results?.[0]) { const r = data.results[0]; ri = typeof r === 'string' ? r : (r.item || r.id); }
        if (!ri) continue;
        if (!items.has(ri)) items.set(ri, { id: ri, name: ri.split(':')[1]?.replace(/_/g,' ') || ri,
          namespace: ri.split(':')[0] || 'minecraft', texture: itemTextures[ri] || null, recipeTypes: [] });
        items.get(ri).recipeTypes.push(recipe.type);
      } catch {}
    }
    // custom recipes
    for (const [, cr] of Object.entries(customRecipes)) {
      try {
        const ri = cr.resultItem;
        if (!items.has(ri)) items.set(ri, { id: ri, name: ri.split(':')[1]?.replace(/_/g,' ') || ri,
          namespace: ri.split(':')[0] || 'minecraft', texture: itemTextures[ri] || null, recipeTypes: [] });
        if (!items.get(ri).recipeTypes.includes(cr.recipeType)) items.get(ri).recipeTypes.push(cr.recipeType);
      } catch {}
    }

    let out = [...items.values()];
    if (ns)     out = out.filter(i => i.namespace === ns);
    if (search) out = out.filter(i => i.id.toLowerCase().includes(search));
    out.sort((a,b) => a.id.localeCompare(b.id));
    res.json({ total: out.length, items: out });
  } catch (error) {
    console.error('[/api/items] ERROR:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// ── Recipes ───────────────────────────────────────────────────────────────
app.get('/api/recipes/:itemId', (req, res) => {
  const itemId  = req.params.itemId.replace(/__/g, ':');
  const recipes = [];

  for (const [id, recipe] of Object.entries(recipesDB)) {
    const data = recipe.data;
    let ri = null;
    if (data.result) ri = typeof data.result === 'string' ? data.result : (data.result.item || data.result.id);
    else if (data.results?.[0]) { const r = data.results[0]; ri = typeof r === 'string' ? r : (r.item || r.id); }
    if (ri === itemId) recipes.push({ id, type: recipe.type, namespace: recipe.namespace, data });
  }
  for (const [id, cr] of Object.entries(customRecipes)) {
    if (cr.resultItem === itemId)
      recipes.push({ id, type: cr.recipeType, namespace: 'custom', data: cr.data, custom: true, grid: cr.grid, resultCount: cr.resultCount });
  }
  res.json({ item: itemId, recipes });
});

app.get('/api/recipe/:id', (req, res) => {
  const r = recipesDB[req.params.id] || customRecipes[req.params.id];
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});

// ── CC Terminal Log ───────────────────────────────────────────────────────
let ccLog = [];  // [{ts, level, msg}]

app.post('/api/cc-log', (req, res) => {
  const { lines, level } = req.body;
  if (!lines) return res.status(400).json({ ok: false });
  const entries = (Array.isArray(lines) ? lines : [lines]).map(msg => ({
    ts: Date.now(), level: level || 'info', msg: String(msg)
  }));
  ccLog.push(...entries);
  if (ccLog.length > 500) ccLog = ccLog.slice(-500);
  broadcast('ccLog', ccLog.slice(-100));
  res.json({ ok: true });
});

app.get('/api/cc-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json({ log: ccLog.slice(-limit), total: ccLog.length });
});

app.delete('/api/cc-log', (req, res) => {
  ccLog = [];
  broadcast('ccLog', []);
  res.json({ ok: true });
});

// ── Debug endpoint ────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  res.json({
    recipesLoaded: Object.keys(recipesDB).length,
    texturesLoaded: Object.keys(itemTextures).length,
    customRecipes: Object.keys(customRecipes).length,
    queueLength: craftingQueue.length,
    logLength: craftLog.length,
    inventory: liveInventory ? { online: true, items: liveInventory.items?.length } : { online: false },
    sseClients: sseClients.size,
    uptime: process.uptime(),
  });
});

// ── Textures map (full) ───────────────────────────────────────────────────
app.get('/api/textures', (req, res) => {
  res.json(itemTextures);
});

// ── Search ────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ items: [], recipes: [] });
  const items = Object.keys(itemTextures).filter(id => id.includes(q)).slice(0,50)
    .map(id => ({ id, name: id.split(':')[1]?.replace(/_/g,' ') || id, texture: itemTextures[id] }));
  const recipes = Object.entries(recipesDB).filter(([id]) => id.includes(q)).slice(0,50)
    .map(([id, r]) => ({ id, type: r.type, namespace: r.namespace }));
  res.json({ items, recipes });
});

// ── Stats ─────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    totalRecipes: Object.keys(recipesDB).length,
    totalItems: Object.keys(itemTextures).length,
    customRecipes: Object.keys(customRecipes).length,
    recipeTypes: recipesIndex.by_type,
    namespaces:  recipesIndex.by_namespace,
  });
});

// ── Inventory ─────────────────────────────────────────────────────────────
app.post('/api/inventory', (req, res) => {
  const data = req.body;
  if (!data?.items) return res.status(400).json({ error: 'invalid' });
  liveInventory      = { computerId: data.computerId, timestamp: data.timestamp, stats: data.stats, items: data.items };
  lastInventoryUpdate = Date.now();
  broadcast('inventory', { stats: data.stats, itemCount: data.items.length });
  res.json({ ok: true });
});

app.get('/api/inventory', (req, res) => {
  if (!liveInventory) return res.json({ online: false, message: 'Run me_terminal.lua' });
  const age = Date.now() - lastInventoryUpdate;
  res.json({ online: age < 10000, age, lastUpdate: new Date(lastInventoryUpdate).toISOString(), ...liveInventory });
});

// ── Craft queue ───────────────────────────────────────────────────────────
app.post('/api/craft', (req, res) => {
  const { itemId, amount } = req.body;
  if (!itemId || !amount) return res.status(400).json({ success: false, message: 'missing fields' });
  const job = { id: queueIdCounter++, itemId, amount, status: 'pending', createdAt: Date.now() };
  craftingQueue.push(job);
  broadcast('queue', craftingQueue);
  console.log(`[CRAFT] queued #${job.id}: ${amount}x ${itemId}`);
  res.json({ success: true, jobId: job.id });
});

app.get('/api/queue', (req, res) => res.json({ queue: craftingQueue, total: craftingQueue.length }));

app.get('/api/queue/next', (req, res) => {
  const job = craftingQueue.find(j => j.status === 'pending');
  if (job) { job.status = 'crafting'; job.startedAt = Date.now(); broadcast('queue', craftingQueue); }
  res.json({ job: job || null });
});

app.post('/api/queue/:id/complete', (req, res) => {
  const job = craftingQueue.find(j => j.id === +req.params.id);
  if (!job) return res.status(404).json({ success: false });
  job.status = 'completed'; job.completedAt = Date.now();
  // log it
  craftLog.push({ jobId: job.id, itemId: job.itemId, amount: job.amount,
    status: 'completed', startedAt: job.startedAt, completedAt: job.completedAt,
    durationMs: job.completedAt - (job.startedAt || job.createdAt) });
  saveLog();
  broadcast('queue', craftingQueue);
  broadcast('log', craftLog.slice(-50));
  console.log(`[CRAFT] #${job.id} completed`);
  setTimeout(() => { craftingQueue = craftingQueue.filter(j => j.id !== job.id); broadcast('queue', craftingQueue); }, 5000);
  res.json({ success: true });
});

app.post('/api/queue/:id/fail', (req, res) => {
  const job = craftingQueue.find(j => j.id === +req.params.id);
  if (!job) return res.status(404).json({ success: false });
  job.status = 'failed'; job.failedAt = Date.now(); job.error = req.body.error || 'unknown';
  craftLog.push({ jobId: job.id, itemId: job.itemId, amount: job.amount,
    status: 'failed', error: job.error, failedAt: job.failedAt });
  saveLog();
  broadcast('queue', craftingQueue);
  broadcast('log', craftLog.slice(-50));
  console.log(`[CRAFT] #${job.id} failed: ${job.error}`);
  res.json({ success: true });
});

app.post('/api/queue/:id/cancel', (req, res) => {
  const idx = craftingQueue.findIndex(j => j.id === +req.params.id && j.status === 'pending');
  if (idx === -1) return res.json({ success: false, message: 'not found or not pending' });
  const [job] = craftingQueue.splice(idx, 1);
  craftLog.push({ jobId: job.id, itemId: job.itemId, amount: job.amount, status: 'cancelled', cancelledAt: Date.now() });
  saveLog();
  broadcast('queue', craftingQueue);
  res.json({ success: true });
});

// ── Craft log ─────────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ log: craftLog.slice(-limit).reverse(), total: craftLog.length });
});

app.delete('/api/log', (req, res) => {
  craftLog = [];
  saveLog();
  broadcast('log', []);
  res.json({ success: true });
});

// ── Custom recipes ────────────────────────────────────────────────────────
app.get('/api/custom-recipes', (req, res) => {
  res.json({ total: Object.keys(customRecipes).length, recipes: Object.values(customRecipes) });
});

app.post('/api/custom-recipes', (req, res) => {
  const { resultItem, resultCount, recipeType, grid, name } = req.body;
  if (!resultItem || !recipeType || !grid || grid.length !== 9)
    return res.status(400).json({ success: false, message: 'invalid body' });

  const id = `custom:${resultItem.replace(':','__')}_${Date.now()}`;
  const recipe = {
    id, name: name || resultItem.split(':')[1] || resultItem,
    resultItem, resultCount: resultCount || 1,
    recipeType, grid,
    createdAt: Date.now(),
    data: buildRecipeData(resultItem, resultCount || 1, recipeType, grid),
  };
  customRecipes[id] = recipe;
  saveCustom();
  broadcast('customRecipes', Object.values(customRecipes));
  console.log(`[CUSTOM] created ${id}`);
  res.json({ success: true, id, recipe });
});

app.delete('/api/custom-recipes/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!customRecipes[id]) return res.status(404).json({ success: false });
  delete customRecipes[id];
  saveCustom();
  broadcast('customRecipes', Object.values(customRecipes));
  res.json({ success: true });
});

function buildRecipeData(resultItem, resultCount, recipeType, grid) {
  if (recipeType === 'minecraft:crafting_shaped' || recipeType === 'create:mechanical_crafting') {
    const key = {}, charMap = {};
    const chars = 'ABCDEFGHI';
    let ci = 0;
    const pattern = [];
    for (let row = 0; row < 3; row++) {
      let r = '';
      for (let col = 0; col < 3; col++) {
        const slot = grid[row * 3 + col];
        if (!slot) { r += ' '; continue; }
        if (!charMap[slot]) {
          charMap[slot] = chars[ci++];
          key[charMap[slot]] = slot.startsWith('#') ? { tag: slot.slice(1) } : { item: slot };
        }
        r += charMap[slot];
      }
      pattern.push(r);
    }
    while (pattern.length && !pattern[0].trim())            pattern.shift();
    while (pattern.length && !pattern[pattern.length-1].trim()) pattern.pop();
    return { pattern, key, result: { item: resultItem, count: resultCount } };
  }
  const ing = grid[4] || grid.find(s => s);
  const ingredient = !ing ? { item: 'minecraft:air' } : ing.startsWith('#') ? { tag: ing.slice(1) } : { item: ing };
  return { ingredients: [ingredient], results: [{ item: resultItem, count: resultCount }] };
}

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 AutoCraft API on http://0.0.0.0:${PORT}`);
  console.log(`   ME Terminal:    /me.html`);
  console.log(`   Craft Manager:  /crafts.html\n`);
});
