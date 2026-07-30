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

// ── Persistent: hardware config (crafters + barrels + vault) ───────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  crafters: [
    { id: 1, crafter: '', redstoneSide: 'left', redstonePeripheral: '', inputs: ['', ''], outputs: ['', ''], enabled: true },
    { id: 2, crafter: '', redstoneSide: 'left', redstonePeripheral: '', inputs: ['', ''], outputs: ['', ''], enabled: false },
    { id: 3, crafter: '', redstoneSide: 'left', redstonePeripheral: '', inputs: ['', ''], outputs: ['', ''], enabled: false },
    { id: 4, crafter: '', redstoneSide: 'left', redstonePeripheral: '', inputs: ['', ''], outputs: ['', ''], enabled: false },
  ],
  vault: '',
  autoMoveToVault: true,
};
try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }; } catch (e) { console.error('[Server] config.json load error:', e.message); }
const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.error('[Server] config save error:', e.message); } };

// ── Live: peripherals discovered by CC ─────────────────────────────────────
let peripherals = [];      // [{name,type}]
let peripheralsAt = null;   // timestamp of last report

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

// ── Recipe → craft grid parser (single source of truth) ────────────────────
// Returns { grid: Array(9)|null, resultCount, mode: 'crafter'|'press' }
// grid slots 1..9 (index 0..8): item-id | '#tag' | null
function buildCraftGrid(recipe) {
  if (!recipe) return { grid: null, resultCount: 1, mode: 'crafter' };

  // Custom recipes already store a ready grid array + resultCount
  if (recipe.custom && Array.isArray(recipe.grid)) {
    const grid = new Array(9).fill(null);
    for (let i = 0; i < 9; i++) {
      const v = recipe.grid[i];
      grid[i] = (v && String(v).trim()) || null;
    }
    return { grid, resultCount: recipe.resultCount || 1, mode: 'crafter' };
  }

  const type = recipe.type || '';
  const data = recipe.data || {};
  const resultCount = extractResultCount(data);

  // shaped / mechanical_crafting → pattern + key
  if (type === 'minecraft:crafting_shaped' || type === 'create:mechanical_crafting') {
    return { grid: gridFromPattern(data), resultCount, mode: 'crafter' };
  }
  // shapeless → fill first N slots
  if (type === 'minecraft:crafting_shapeless') {
    const grid = new Array(9).fill(null);
    const ings = data.ingredients || [];
    for (let i = 0; i < Math.min(9, ings.length); i++) {
      const id = extractIngredientId(ings[i]);
      if (id) grid[i] = id;
    }
    return { grid, resultCount, mode: 'crafter' };
  }
  // single-ingredient Create processes (pressing/cutting/milling/crushing/sandpaper)
  if (type === 'create:pressing' || type === 'create:milling' || type === 'create:crushing' ||
      type === 'create:cutting'  || type === 'create:sandpaper_polishing') {
    const grid = new Array(9).fill(null);
    const ings = data.ingredients || data.ingredient;
    const id = extractIngredientId(Array.isArray(ings) ? ings[0] : ings);
    if (id) grid[4] = id; // center slot
    return { grid, resultCount, mode: 'press' };
  }
  // Multi-ingredient Create processes (mixing / spout / deploying) → first N slots
  if (type === 'create:mixing' || type === 'create:spout_filling' || type === 'create:deploying') {
    const grid = new Array(9).fill(null);
    const ings = data.ingredients || [];
    const arr  = Array.isArray(ings) ? ings : [ings];
    for (let i = 0; i < Math.min(9, arr.length); i++) {
      const id = extractIngredientId(arr[i]);
      if (id) grid[i] = id;
    }
    return { grid, resultCount, mode: 'press' };
  }
  // Any other create:* recipe type → try single ingredient at center
  if (type.startsWith('create:') && type !== 'create:mechanical_crafting') {
    const grid = new Array(9).fill(null);
    const ings = data.ingredients || data.ingredient;
    const id = extractIngredientId(Array.isArray(ings) ? ings[0] : ings);
    if (id) grid[4] = id;
    return { grid, resultCount, mode: 'press' };
  }
  return { grid: null, resultCount, mode: 'crafter' };
}

function gridFromPattern(data) {
  const pattern = data.pattern || [];
  const key = data.key || {};
  const grid = new Array(9).fill(null);
  for (let row = 0; row < 3; row++) {
    const rowStr = pattern[row] || '';
    for (let col = 0; col < 3; col++) {
      const ch = rowStr[col] || ' ';
      if (ch !== ' ' && key[ch]) {
        const id = extractIngredientId(key[ch]);
        if (id) grid[row * 3 + col] = id;
      }
    }
  }
  return grid;
}

function extractIngredientId(ing) {
  if (!ing) return null;
  if (typeof ing === 'string') return ing;
  if (typeof ing !== 'object') return null;
  if (ing.item) return ing.item;
  if (ing.tag) return '#' + ing.tag;
  // alternatives array [{item},{tag},...]
  if (Array.isArray(ing)) {
    for (const sub of ing) {
      const id = extractIngredientId(sub);
      if (id) return id;
    }
  }
  return null;
}

function extractResultCount(data) {
  if (!data) return 1;
  const r = data.result;
  if (r && typeof r === 'object' && r.count) return r.count;
  if (data.results && data.results[0]) {
    const r2 = data.results[0];
    if (typeof r2 === 'object' && r2.count) return r2.count;
  }
  return 1;
}

// Attach craft metadata to a recipe object (mutates)
function withCraft(recipe) {
  if (!recipe) return recipe;
  try {
    const c = buildCraftGrid(recipe);
    recipe.craft = c;
  } catch (e) {
    recipe.craft = { grid: null, resultCount: 1, mode: 'crafter', error: e.message };
  }
  return recipe;
}

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
    if (ri === itemId) recipes.push(withCraft({ id, type: recipe.type, namespace: recipe.namespace, data }));
  }
  for (const [id, cr] of Object.entries(customRecipes)) {
    if (cr.resultItem === itemId)
      recipes.push(withCraft({ id, type: cr.recipeType, namespace: 'custom', data: cr.data, custom: true, grid: cr.grid, resultCount: cr.resultCount }));
  }
  res.json({ item: itemId, recipes });
});

app.get('/api/recipe/:id', (req, res) => {
  const r = recipesDB[req.params.id] || customRecipes[req.params.id];
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(withCraft({ ...r }));
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
  const data = req.body || {};
  // Be tolerant: items must be an array (even empty). stats optional.
  if (!Array.isArray(data.items)) {
    console.error('[/api/inventory] rejected: items is not an array, got', typeof data.items);
    return res.status(400).json({ ok: false, error: 'items must be an array' });
  }
  liveInventory = {
    computerId: data.computerId,
    timestamp: data.timestamp,
    stats: data.stats || {},
    items: data.items,
  };
  lastInventoryUpdate = Date.now();
  console.log(`[/api/inventory] saved ${data.items.length} items, stats=`, data.stats);
  // Send full items in the broadcast so the frontend doesn't need a second fetch.
  broadcast('inventory', { online: true, stats: data.stats, items: data.items });
  res.json({ ok: true, saved: data.items.length });
});

app.get('/api/inventory', (req, res) => {
  if (!liveInventory) return res.json({ online: false, message: 'Run me_terminal.lua' });
  const age = Date.now() - lastInventoryUpdate;
  res.json({
    online: age < 10000,
    age,
    lastUpdate: new Date(lastInventoryUpdate).toISOString(),
    rawItemCount: liveInventory.items?.length || 0,
    ...liveInventory,
  });
});

// ── Hardware config (crafters + barrels + vault) ──────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ config, peripherals, peripheralsAt: peripheralsAt ? new Date(peripheralsAt).toISOString() : null });
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (body.crafters) {
    if (!Array.isArray(body.crafters)) return res.status(400).json({ ok: false, error: 'crafters must be an array' });
    // Normalize each crafter entry
    config.crafters = body.crafters.map((c, i) => ({
      id: c.id || i + 1,
      crafter: String(c.crafter || ''),
      redstoneSide: String(c.redstoneSide || 'left'),
      redstonePeripheral: String(c.redstonePeripheral || ''),
      inputs: Array.isArray(c.inputs) ? c.inputs.slice(0, 2).map(s => String(s || '')) : ['', ''],
      outputs: Array.isArray(c.outputs) ? c.outputs.slice(0, 2).map(s => String(s || '')) : ['', ''],
      enabled: !!c.enabled,
    }));
  }
  if (typeof body.vault === 'string')        config.vault = body.vault;
  if (typeof body.autoMoveToVault === 'boolean') config.autoMoveToVault = body.autoMoveToVault;
  saveConfig();
  broadcast('config', config);
  console.log('[/api/config] saved', config.crafters.filter(c => c.enabled).length, 'enabled crafters');
  res.json({ ok: true, config });
});

// CC reports discovered peripherals (name + type)
app.post('/api/peripherals', (req, res) => {
  const list = req.body?.peripherals;
  if (!Array.isArray(list)) return res.status(400).json({ ok: false, error: 'peripherals must be an array' });
  peripherals = list.map(p => ({ name: String(p.name || ''), type: String(p.type || '') }));
  peripheralsAt = Date.now();
  broadcast('peripherals', peripherals);
  res.json({ ok: true, count: peripherals.length });
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
  const crafterId = req.query.crafterId ? parseInt(req.query.crafterId) : null;
  // Attach the crafter that will run this job (for multi-crafter routing)
  const crafter = crafterId
    ? config.crafters.find(c => c.id === crafterId && c.enabled && c.crafter)
    : config.crafters.find(c => c.enabled && c.crafter);
  const job = craftingQueue.find(j => j.status === 'pending');
  if (job) {
    job.status = 'crafting';
    job.startedAt = Date.now();
    if (crafter) job.crafterId = crafter.id;
    broadcast('queue', craftingQueue);
  }
  res.json({ job: job || null, crafter: crafter || null });
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
  // Shaped / mechanical crafting → reconstruct pattern + key
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

  // Helper: convert a grid slot ("#tag" or "item:id") into an ingredient object
  const toIngredient = (slot) => !slot ? null
    : slot.startsWith('#') ? { tag: slot.slice(1) } : { item: slot };

  // Shapeless → all filled slots become ingredients
  if (recipeType === 'minecraft:crafting_shapeless') {
    const ingredients = grid.filter(Boolean).map(toIngredient).filter(Boolean);
    return { ingredients, result: { item: resultItem, count: resultCount } };
  }

  // Mixing → 2 ingredients packed at slots 3 & 4 (or wherever filled)
  if (recipeType === 'create:mixing') {
    const ingredients = grid.filter(Boolean).map(toIngredient).filter(Boolean);
    // Create-style mixing uses a "heat_requirement" sometimes; keep it optional
    return { ingredients, results: [{ item: resultItem, count: resultCount }] };
  }

  // Spout filling → 1 item + 1 fluid container (2 ingredients if present)
  if (recipeType === 'create:spout_filling') {
    const ingredients = grid.filter(Boolean).map(toIngredient).filter(Boolean);
    return { ingredients, results: [{ item: resultItem, count: resultCount }] };
  }

  // Deployer → 2 ingredients (item + held item) if present, else 1
  if (recipeType === 'create:deploying') {
    const ingredients = grid.filter(Boolean).map(toIngredient).filter(Boolean);
    return { ingredients, results: [{ item: resultItem, count: resultCount }] };
  }

  // Single-ingredient machines: press / mill / crush / cut / sandpaper
  // Prefer center slot (4), fall back to first filled slot
  const ing = grid[4] || grid.find(s => s);
  const ingredient = toIngredient(ing) || { item: 'minecraft:air' };
  return { ingredients: [ingredient], results: [{ item: resultItem, count: resultCount }] };
}

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 AutoCraft API on http://0.0.0.0:${PORT}`);
  console.log(`   ME Terminal:    /me.html`);
  console.log(`   Craft Manager:  /crafts.html\n`);
});
