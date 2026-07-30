const API = window.location.origin;

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────
let itemsMap      = {};   // id → {id,name,texture,namespace,count}  (all known items)
let customRecipes = [];
let craftQueue    = [];
let craftLog      = [];
let liveInventory = [];   // items currently in storage (from /api/inventory)

// Setup
let hwConfig = { crafters: [], vault: '', autoMoveToVault: true };
let hwPeriph = [];   // [{name,type}] discovered by CC

// Builder
let builderGrid     = new Array(9).fill(null); // slot index 0-8 → itemId|null
let builderResult   = null;
let builderMode     = 'crafting_shaped'; // current machine type
let singleIngredient = null;              // for press/mill/crush/cut/sandpaper/spout/deployer
let mixIngredients   = [null, null];      // for mixing (up to 2)
let shapelessSlots   = [];               // [{itemId}] for shapeless crafting

// Drag
let dragItemId    = null;

// ─────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────
async function init() {
  // Load items from /api/items - has textures already baked in
  await loadCraftableItems();
  // Try to load live inventory for storage panel
  await loadInventory();
  await loadCustomRecipes();
  await loadQueue();
  await loadLog();
  await loadCcLog();
  await loadConfig();
  buildGrid();
  onTypeChange();        // show correct input section for default type
  renderStoragePanel();
  connectSSE();
}

// ─────────────────────────────────────────────────────────────────────────
// Hardware config (crafters + barrels + vault)
// ─────────────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch(`${API}/api/config`);
    const d = await r.json();
    if (d.config) hwConfig = d.config;
    if (d.peripherals) hwPeriph = d.peripherals;
    updatePeriphStatus(d);
    renderSetup();
  } catch(e) { console.error('loadConfig:', e); }
}

async function reloadPeriph() {
  try {
    const r = await fetch(`${API}/api/config`);
    const d = await r.json();
    if (d.peripherals) hwPeriph = d.peripherals;
    updatePeriphStatus(d);
    renderSetup();
    showToast(`Found ${hwPeriph.length} peripherals`, 'success');
  } catch(e) { showToast('Refresh failed', 'error'); }
}

function updatePeriphStatus(d) {
  const cnt = document.getElementById('setupPeriphCount');
  const at  = document.getElementById('setupPeriphAt');
  if (cnt) cnt.textContent = hwPeriph.length;
  if (at && d && d.peripheralsAt) {
    const mins = Math.round((Date.now() - new Date(d.peripheralsAt).getTime()) / 60000);
    at.textContent = `updated ${mins}m ago`;
  } else if (at) {
    at.textContent = 'CC offline';
  }
}

// Filter peripherals by category for dropdowns
function periphOptions(category) {
  let list = hwPeriph.filter(p => {
    const n = (p.name || '').toLowerCase();
    const t = (p.type || '').toLowerCase();
    if (category === 'crafter') return n.includes('crafter') || n.includes('autocrafter');
    if (category === 'barrel')  return n.includes('barrel') || t.includes('barrel');
    if (category === 'vault')   return n.includes('vault') || t.includes('vault');
    if (category === 'relay')   return n.includes('relay') || t.includes('relay');
    return true;
  });
  return list;
}

function periphSelect(selected, category, placeholder) {
  const opts = periphOptions(category);
  let html = `<option value="">${placeholder || '— select —'}</option>`;
  opts.forEach(p => {
    const sel = p.name === selected ? ' selected' : '';
    html += `<option value="${p.name}"${sel}>${p.name} (${p.type})</option>`;
  });
  // If the current value isn't in the discovered list, keep it as a manual option
  if (selected && !opts.some(p => p.name === selected)) {
    html += `<option value="${selected}" selected>${selected} (saved)</option>`;
  }
  return html;
}

function isPeriphOnline(name) {
  return hwPeriph.some(p => p.name === name);
}

function renderSetup() {
  const grid = document.getElementById('crafterCards');
  if (!grid) return;
  // Ensure 4 crafter slots
  if (!hwConfig.crafters || hwConfig.crafters.length < 4) {
    hwConfig.crafters = hwConfig.crafters || [];
    while (hwConfig.crafters.length < 4) {
      const i = hwConfig.crafters.length;
      hwConfig.crafters.push({ id:i+1, crafter:'', redstoneSide:'left', redstonePeripheral:'', outputs:['',''], enabled: i===0 });
    }
  }

  const sides = ['left','right','front','back','top','bottom'];
  const sideOpts = (sel) => sides.map(s => `<option value="${s}"${s===sel?' selected':''}>${s}</option>`).join('');

  grid.innerHTML = hwConfig.crafters.map((c, i) => `
    <div class="crafter-card ${c.enabled?'enabled':'disabled'}">
      <div class="crafter-card-head">
        <span class="crafter-card-title">CRAFTER ${c.id}</span>
        <div>
          <span class="crafter-online ${c.crafter && isPeriphOnline(c.crafter)?'on':''}" title="${c.crafter && isPeriphOnline(c.crafter)?'online':'offline'}"></span>
          <label class="crafter-toggle">
            <input type="checkbox" ${c.enabled?'checked':''} onchange="hwConfig.crafters[${i}].enabled=this.checked; renderSetup();">
            Enabled
          </label>
        </div>
      </div>
      <div class="setup-field">
        <label>Autocrafter (minecraft:crafter_N)</label>
        <select onchange="hwConfig.crafters[${i}].crafter=this.value; renderSetup();">${periphSelect(c.crafter,'crafter','— select crafter —')}</select>
      </div>
      <div class="setup-row-2">
        <div class="setup-field">
          <label>Redstone side</label>
          <select onchange="hwConfig.crafters[${i}].redstoneSide=this.value;">${sideOpts(c.redstoneSide||'left')}</select>
        </div>
        <div class="setup-field">
          <label>Redstone relay (optional)</label>
          <select onchange="hwConfig.crafters[${i}].redstonePeripheral=this.value;">${periphSelect(c.redstonePeripheral||'','relay','— direct side —')}</select>
        </div>
      </div>
      <div class="setup-field" style="margin-bottom:0">
        <div class="barrel-pair-label">Output barrels <span class="tag out">OUT</span> <span style="font-size:8px;color:var(--parchment-faint);margin-left:6px;font-family:'JetBrains Mono',monospace">(items from ME go directly to crafter)</span></div>
        <div class="setup-row-2">
          <select onchange="hwConfig.crafters[${i}].outputs[0]=this.value;">${periphSelect((c.outputs||['',''])[0],'barrel','— barrel 1 —')}</select>
          <select onchange="hwConfig.crafters[${i}].outputs[1]=this.value;">${periphSelect((c.outputs||['',''])[1],'barrel','— barrel 2 —')}</select>
        </div>
      </div>
    </div>
  `).join('');

  // Vault select + automove checkbox
  const vs = document.getElementById('vaultSelect');
  const am = document.getElementById('autoMoveToVault');
  if (vs) vs.innerHTML = periphSelect(hwConfig.vault||'','vault','— no vault (keep in barrels) —');
  if (am) am.checked = !!hwConfig.autoMoveToVault;
}

async function saveConfig() {
  const am = document.getElementById('autoMoveToVault');
  if (am) hwConfig.autoMoveToVault = am.checked;
  // Validate enabled crafters have at least a crafter selected
  const bad = hwConfig.crafters.filter(c => c.enabled && !c.crafter);
  if (bad.length) { showToast(`${bad.length} enabled crafter(s) have no peripheral selected`, 'error'); return; }
  try {
    const r = await fetch(`${API}/api/config`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(hwConfig)
    });
    const d = await r.json();
    if (d.ok) {
      showToast('Configuration saved', 'success');
      const el = document.getElementById('setupSaved');
      if (el) { el.textContent = '✓ saved ' + new Date().toLocaleTimeString(); }
    } else showToast('Save failed: '+(d.error||'?'), 'error');
  } catch(e) { showToast('Save failed', 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────
// Item texture helper — ONE source of truth
// tex is stored as "textures/namespace__name.png"
// static files served at /textures/… by express
// ─────────────────────────────────────────────────────────────────────────
function texUrl(itemId) {
  const item = itemsMap[itemId];
  // Use stored texture path OR guess it from item id
  const tex = item?.texture;
  if (tex) return '/' + tex;
  // Fallback: guess standard path namespace__name.png
  const ns   = itemId?.split(':')[0];
  const name = itemId?.split(':')[1];
  if (ns && name) return `/textures/${ns}__${name}.png`;
  return null;
}

function itemImg(itemId, size) {
  const url = texUrl(itemId);
  const sz  = size ? `width:${size};height:${size}` : 'width:100%;height:100%';
  if (url) {
    const img = document.createElement('img');
    img.src   = url;
    img.style.cssText = sz + ';image-rendering:pixelated;display:block';
    img.addEventListener('error', function() {
      this.style.display = 'none';
      const span = document.createElement('span');
      span.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:14px';
      span.textContent = '📦';
      this.parentElement && this.parentElement.appendChild(span);
    });
    // return as wrapper div that JS can insert
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden';
    wrap.appendChild(img);
    return wrap.outerHTML;
  }
  return '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:14px">📦</span>';
}

// ─────────────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────────────
async function loadCraftableItems() {
  try {
    const r = await fetch(`${API}/api/items`);
    const d = await r.json();
    (d.items || []).forEach(i => {
      itemsMap[i.id] = { ...i, count: itemsMap[i.id]?.count || 0 };
    });
  } catch(e) { console.error('loadCraftableItems:', e); }
}

async function loadInventory() {
  try {
    const r = await fetch(`${API}/api/inventory`);
    const d = await r.json();
    if (d.online && d.items) {
      liveInventory = d.items;
      // Merge into itemsMap with counts + textures
      d.items.forEach(i => {
        if (!itemsMap[i.id]) {
          itemsMap[i.id] = {
            id: i.id,
            name: i.name || i.id.split(':')[1] || i.id,
            namespace: i.namespace || i.id.split(':')[0],
            texture: null,
            count: i.count
          };
        } else {
          itemsMap[i.id].count = i.count;
        }
      });
      renderStoragePanel();
    }
  } catch {}
}

async function loadCustomRecipes() {
  try {
    const r = await fetch(`${API}/api/custom-recipes`);
    const d = await r.json();
    customRecipes = d.recipes || [];
    renderRecipes();
    document.getElementById('customCount').textContent = customRecipes.length;
  } catch {}
}

async function loadQueue() {
  try {
    const r = await fetch(`${API}/api/queue`);
    const d = await r.json();
    craftQueue = d.queue || [];
    renderQueue();
  } catch {}
}

async function loadLog() {
  try {
    const r = await fetch(`${API}/api/log?limit=200`);
    const d = await r.json();
    craftLog = d.log || [];
    renderLog();
    document.getElementById('logCount').textContent = d.total || 0;
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────
// SSE — live updates
// ─────────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es  = new EventSource(`${API}/api/events`);
  const dot = document.getElementById('sseStatus');
  const txt = document.getElementById('sseText');

  es.addEventListener('inventory', async () => {
    await loadInventory();
  });
  es.addEventListener('queue', e => {
    craftQueue = JSON.parse(e.data);
    renderQueue();
  });
  es.addEventListener('log', e => {
    craftLog = JSON.parse(e.data);
    renderLog();
  });
  es.addEventListener('customRecipes', e => {
    customRecipes = JSON.parse(e.data);
    renderRecipes();
    document.getElementById('customCount').textContent = customRecipes.length;
  });
  es.addEventListener('ccLog', e => {
    renderCcLog(JSON.parse(e.data));
  });
  es.addEventListener('config', e => {
    hwConfig = JSON.parse(e.data);
    renderSetup();
  });
  es.addEventListener('peripherals', e => {
    hwPeriph = JSON.parse(e.data);
    updatePeriphStatus({ peripheralsAt: new Date().toISOString() });
    renderSetup();
  });

  es.onopen  = () => { dot.classList.add('online');    txt.textContent = 'LIVE';       };
  es.onerror = () => { dot.classList.remove('online'); txt.textContent = 'OFFLINE'; };
}


// ─────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', ['builder','recipes','queue','history','cclog','setup'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'tab-'+name);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Storage panel (left side of builder)
// Drag items from here into craft grid slots
// ─────────────────────────────────────────────────────────────────────────
function renderStoragePanel() {
  const panel = document.getElementById('storagePanel');
  const search = (document.getElementById('storageSearch')?.value || '').toLowerCase();
  if (!panel) return;

  // Sort by count desc, filter by search
  let items = Object.values(itemsMap).filter(i => i.count > 0);
  if (items.length === 0) {
    // Fallback: show all craftable items
    items = Object.values(itemsMap);
  }

  if (search) {
    items = items.filter(i => i.id.toLowerCase().includes(search) ||
                               (i.name||'').toLowerCase().includes(search));
  }

  items.sort((a, b) => (b.count||0) - (a.count||0) || a.id.localeCompare(b.id));
  items = items.slice(0, 200);

  panel.innerHTML = '';
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'storage-item';
    el.title = item.id + (item.count ? ` (${item.count})` : '');
    el.draggable = true;
    el.innerHTML = `
      <div class="storage-item-icon">${itemImg(item.id)}</div>
      ${item.count > 0 ? `<div class="storage-item-count">${fmtCount(item.count)}</div>` : ''}
      <div class="storage-item-name">${(item.name||item.id.split(':')[1]||item.id).slice(0,9)}</div>`;

    // Drag start
    el.addEventListener('dragstart', e => {
      dragItemId = item.id;
      e.dataTransfer.effectAllowed = 'copy';
      el.style.opacity = '0.5';
    });
    el.addEventListener('dragend', () => { el.style.opacity = ''; dragItemId = null; });

    // Click also selects (for touch / no-drag)
    el.addEventListener('click', () => openClickPicker(item.id));

    panel.appendChild(el);
  });
}

function fmtCount(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000)    return (n/1000).toFixed(1)+'K';
  return String(n);
}

// When user clicks a storage item → select which slot to put it in
let pendingClickItem = null;
function openClickPicker(itemId) {
  pendingClickItem = itemId;
  showToast(`Selected: ${itemId.split(':')[1]} — now click a recipe slot`, 'success');
}

// ─────────────────────────────────────────────────────────────────────────
// Craft Grid
// ─────────────────────────────────────────────────────────────────────────
function buildGrid() {
  const g = document.getElementById('craftGrid');
  g.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const slot = document.createElement('div');
    slot.className = 'craft-slot';
    slot.dataset.idx = i;
    slot.innerHTML = `<span class="slot-num">${i+1}</span>`;

    // Drop target
    slot.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect='copy'; slot.classList.add('drag-over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
    slot.addEventListener('drop',      e => { e.preventDefault(); slot.classList.remove('drag-over'); if (dragItemId) setSlot(i, dragItemId); });

    // Click: either place pending item or open search popup
    slot.addEventListener('click', () => {
      if (pendingClickItem) { setSlot(i, pendingClickItem); pendingClickItem = null; }
      else openSlotPicker(i);
    });

    // Right-click clears
    slot.addEventListener('contextmenu', e => { e.preventDefault(); setSlot(i, null); });
    g.appendChild(slot);
  }
  refreshGrid();
}

function setSlot(i, itemId) {
  builderGrid[i] = itemId;
  refreshGrid();
}

function refreshGrid() {
  for (let i = 0; i < 9; i++) {
    const el = document.querySelector(`#craftGrid .craft-slot[data-idx="${i}"]`);
    if (!el) continue;
    const id = builderGrid[i];
    el.classList.toggle('filled', !!id);
    if (id) {
      el.innerHTML = `<span class="slot-num">${i+1}</span>${itemImg(id)}`;
    } else {
      el.innerHTML = `<span class="slot-num">${i+1}</span>`;
    }
    // re-attach drag events (innerHTML wipes them on parent)
    el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop',      e => { e.preventDefault(); el.classList.remove('drag-over'); if (dragItemId) setSlot(i, dragItemId); });
  }
  updatePreview();
}

function onTypeChange() {
  const t = document.getElementById('recipeType').value;
  builderMode = t;

  // Determine which input section to show based on machine type
  const grid3x3     = document.getElementById('grid3x3Section');
  const single      = document.getElementById('singleSection');
  const mixing      = document.getElementById('mixingSection');
  const shapeless   = document.getElementById('shapelessSection');
  if (grid3x3)   grid3x3.style.display   = 'none';
  if (single)    single.style.display    = 'none';
  if (mixing)    mixing.style.display    = 'none';
  if (shapeless) shapeless.style.display = 'none';

  // Shaped / mechanical crafting → 3×3 grid
  if (t === 'minecraft:crafting_shaped' || t === 'create:mechanical_crafting') {
    if (grid3x3) grid3x3.style.display = '';
    attachRightClickClear('singleSlot',   () => setSingleIngredient(null));
    attachRightClickClear('mixSlot1',     () => setMixIngredient(0, null));
    attachRightClickClear('mixSlot2',     () => setMixIngredient(1, null));
  }
  // Mixing → 2 ingredients
  else if (t === 'create:mixing') {
    if (mixing) mixing.style.display = '';
    attachRightClickClear('singleSlot', () => setSingleIngredient(null));
    attachRightClickClear('mixSlot1',   () => setMixIngredient(0, null));
    attachRightClickClear('mixSlot2',   () => setMixIngredient(1, null));
  }
  // Shapeless crafting → dynamic slots
  else if (t === 'minecraft:crafting_shapeless') {
    if (shapeless) shapeless.style.display = '';
    renderShapelessSlots();
    attachRightClickClear('singleSlot', () => setSingleIngredient(null));
    attachRightClickClear('mixSlot1',   () => setMixIngredient(0, null));
    attachRightClickClear('mixSlot2',   () => setMixIngredient(1, null));
  }
  // Single-ingredient machines (press/mill/crush/cut/sandpaper/spout/deployer)
  else {
    if (single) single.style.display = '';
    attachRightClickClear('singleSlot', () => setSingleIngredient(null));
    attachRightClickClear('mixSlot1',   () => setMixIngredient(0, null));
    attachRightClickClear('mixSlot2',   () => setMixIngredient(1, null));
  }
  updatePreview();
}

// Attach right-click handler to clear a slot (idempotent — safe to call repeatedly)
function attachRightClickClear(elementId, clearFn) {
  const el = document.getElementById(elementId);
  if (!el || el._rcAttached) return;
  el._rcAttached = true;
  el.addEventListener('contextmenu', e => { e.preventDefault(); clearFn(); updatePreview(); });
}

// ── Single-ingredient helpers (press/mill/crush/cut/sandpaper/spout/deployer)
function setSingleIngredient(itemId) {
  singleIngredient = itemId;
  const el = document.getElementById('singleSlot');
  if (el) {
    if (itemId) el.innerHTML = itemImg(itemId);
    else        el.innerHTML = '<span style="font-size:20px">+</span>';
  }
}

// ── Mixing helpers (2 ingredients)
function setMixIngredient(idx, itemId) {
  mixIngredients[idx] = itemId;
  const el = document.getElementById(idx === 0 ? 'mixSlot1' : 'mixSlot2');
  if (el) {
    if (itemId) el.innerHTML = itemImg(itemId);
    else        el.innerHTML = '<span style="font-size:20px">+</span>';
  }
}

// ── Shapeless helpers (dynamic slots, up to 9)
function addShapelessSlot() {
  if (shapelessSlots.length >= 9) { showToast('Max 9 ingredients', 'error'); return; }
  shapelessSlots.push({ itemId: null });
  renderShapelessSlots();
}

function removeShapelessSlot(idx) {
  shapelessSlots.splice(idx, 1);
  renderShapelessSlots();
  updatePreview();
}

function setShapelessSlot(idx, itemId) {
  if (shapelessSlots[idx]) shapelessSlots[idx].itemId = itemId;
  renderShapelessSlots();
}

function renderShapelessSlots() {
  const wrap = document.getElementById('shapelessSlots');
  if (!wrap) return;
  wrap.innerHTML = '';
  shapelessSlots.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'craft-slot';
    el.style.cssText = 'width:48px;height:48px;position:relative';
    el.innerHTML = s.itemId
      ? itemImg(s.itemId)
      : '<span style="font-size:16px;color:var(--parchment-faint)">+</span>';
    // Click opens picker for this shapeless index
    el.addEventListener('click', () => openSlotPicker(-100 - i));
    // Right-click clears
    el.addEventListener('contextmenu', e => { e.preventDefault(); setShapelessSlot(i, null); });
    // Drag-drop
    el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop',      e => { e.preventDefault(); el.classList.remove('drag-over');
                                             if (dragItemId) setShapelessSlot(i, dragItemId); });
    // Small remove button overlay
    if (s.itemId) {
      const x = document.createElement('div');
      x.textContent = '×';
      x.style.cssText = 'position:absolute;top:-6px;right:-6px;width:16px;height:16px;background:var(--rust);color:var(--parchment);border-radius:50%;font-size:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:monospace';
      x.title = 'remove';
      x.addEventListener('click', ev => { ev.stopPropagation(); removeShapelessSlot(i); });
      el.appendChild(x);
    }
    wrap.appendChild(el);
  });
}

function countFilled() {
  const t = builderMode;
  if (t === 'minecraft:crafting_shaped' || t === 'create:mechanical_crafting') {
    return builderGrid.filter(Boolean).length;
  }
  if (t === 'create:mixing') {
    return mixIngredients.filter(Boolean).length;
  }
  if (t === 'minecraft:crafting_shapeless') {
    return shapelessSlots.filter(s => s && s.itemId).length;
  }
  // single
  return singleIngredient ? 1 : 0;
}

function updatePreview() {
  const type  = document.getElementById('recipeType').value;
  const count = document.getElementById('resultCount').value;
  if (!builderResult) {
    document.getElementById('recipePreview').innerHTML =
      '<span style="color:var(--parchment-faint)">Set result item →</span>';
    return;
  }
  const filled = countFilled();
  document.getElementById('recipePreview').innerHTML = `
    <div style="margin-bottom:4px"><span style="color:var(--parchment-faint)">Type: </span><span style="color:var(--brass-bright)">${type}</span></div>
    <div><span style="color:var(--parchment-faint)">Result: </span><span style="color:var(--parchment)">${builderResult} ×${count}</span></div>
    <div style="margin-top:4px"><span style="color:var(--parchment-faint)">Ingredients: </span><span style="color:var(--parchment)">${filled}</span></div>`;
}


// ─────────────────────────────────────────────────────────────────────────
// Slot picker popup (search all items to place in a slot)
// ─────────────────────────────────────────────────────────────────────────
let pickerTarget = null;

function openSlotPicker(slotIdx) {
  pickerTarget = slotIdx;
  document.getElementById('overlay').classList.add('show');
  document.getElementById('itemPopup').classList.add('show');
  document.getElementById('popupSearch').value = '';
  filterPopup();
  setTimeout(() => document.getElementById('popupSearch').focus(), 50);
}

function openResultPicker() {
  pickerTarget = -1;
  document.getElementById('overlay').classList.add('show');
  document.getElementById('itemPopup').classList.add('show');
  document.getElementById('popupSearch').value = '';
  filterPopup();
  setTimeout(() => document.getElementById('popupSearch').focus(), 50);
}

function closeItemPicker() {
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('itemPopup').classList.remove('show');
}

function filterPopup() {
  const q    = document.getElementById('popupSearch').value.toLowerCase().trim();
  const list = document.getElementById('popupList');

  let items = Object.values(itemsMap);
  if (q) {
    items = items.filter(i => i.id.toLowerCase().includes(q) || (i.name||'').toLowerCase().includes(q));
    items.sort((a,b) => {
      const an = (a.name||'').toLowerCase(), bn = (b.name||'').toLowerCase();
      return (an.startsWith(q)?0:1) - (bn.startsWith(q)?0:1) || an.localeCompare(bn);
    });
  } else {
    // Default: in-storage items first, then rest alphabetically
    items.sort((a,b) => (b.count||0)-(a.count||0) || a.id.localeCompare(b.id));
  }

  items = items.slice(0, 120);
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--parchment-faint);font-size:11px;font-family:\'JetBrains Mono\',monospace">Nothing found</div>';
    return;
  }

  items.forEach(item => {
    const el  = document.createElement('div');
    el.className = 'popup-item';
    el.innerHTML = `
      <div class="popup-item-icon">${itemImg(item.id, '32px')}</div>
      <div>
        <div class="popup-item-name">${item.name || item.id.split(':')[1] || item.id}</div>
        <div class="popup-item-id">${item.id}${item.count>0?' · '+fmtCount(item.count):''}</div>
      </div>`;
    el.addEventListener('click', () => pickItem(item.id));
    list.appendChild(el);
  });
}

function pickItem(itemId) {
  closeItemPicker();
  if (pickerTarget === -1) {
    builderResult = itemId;
    const el = document.getElementById('resultSlot');
    el.innerHTML = itemImg(itemId);
    el.classList.add('filled');
  } else if (pickerTarget !== null && pickerTarget !== undefined) {
    // -2 → single ingredient slot
    if (pickerTarget === -2) {
      setSingleIngredient(itemId);
    }
    // -3 / -4 → mixing slot 0 / 1
    else if (pickerTarget === -3) {
      setMixIngredient(0, itemId);
    }
    else if (pickerTarget === -4) {
      setMixIngredient(1, itemId);
    }
    // -100 - i → shapeless slot i
    else if (pickerTarget <= -100) {
      const idx = -pickerTarget - 100;
      setShapelessSlot(idx, itemId);
    }
    // 0..8 → 3×3 grid slot
    else if (pickerTarget >= 0 && pickerTarget < 9) {
      setSlot(pickerTarget, itemId);
    }
  }
  updatePreview();
}

// ─────────────────────────────────────────────────────────────────────────
// Save recipe
// ─────────────────────────────────────────────────────────────────────────
async function saveRecipe() {
  if (!builderResult) { showToast('Set result item first', 'error'); return; }
  const type  = document.getElementById('recipeType').value;
  const count = parseInt(document.getElementById('resultCount').value) || 1;
  const name  = document.getElementById('recipeName').value.trim();

  // Build a 9-element grid for storage. Layout depends on machine type:
  //  - shaped / mechanical_crafting: actual 3×3 layout
  //  - single (press/mill/crush/...): ingredient at slot 4 (center)
  //  - mixing: 2 ingredients at slots 3 & 4 (packed in first slots)
  //  - shapeless: ingredients in first N slots
  const grid = new Array(9).fill(null);
  if (type === 'minecraft:crafting_shaped' || type === 'create:mechanical_crafting') {
    for (let i = 0; i < 9; i++) grid[i] = builderGrid[i];
  } else if (type === 'create:mixing') {
    if (mixIngredients[0]) grid[3] = mixIngredients[0];
    if (mixIngredients[1]) grid[4] = mixIngredients[1];
  } else if (type === 'minecraft:crafting_shapeless') {
    shapelessSlots.filter(s => s && s.itemId).forEach((s, i) => { if (i < 9) grid[i] = s.itemId; });
  } else {
    // single-ingredient: place at center slot
    if (singleIngredient) grid[4] = singleIngredient;
  }

  if (!grid.some(Boolean)) { showToast('Add at least one ingredient', 'error'); return; }

  const r = await fetch(`${API}/api/custom-recipes`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ resultItem: builderResult, resultCount: count, recipeType: type, grid, name })
  });
  const d = await r.json();
  if (d.success) {
    showToast(`Saved: ${count}× ${builderResult}`, 'success');
    resetBuilder();
  } else {
    showToast('Failed: ' + d.message, 'error');
  }
}

function resetBuilder() {
  builderGrid       = new Array(9).fill(null);
  builderResult     = null;
  singleIngredient  = null;
  mixIngredients    = [null, null];
  shapelessSlots    = [];
  document.getElementById('resultSlot').innerHTML = '<span style="font-size:24px">+</span>';
  document.getElementById('resultSlot').classList.remove('filled');
  document.getElementById('recipeName').value = '';
  // Reset all slot visuals
  setSingleIngredient(null);
  setMixIngredient(0, null);
  setMixIngredient(1, null);
  renderShapelessSlots();
  refreshGrid();
  updatePreview();
}

// ─────────────────────────────────────────────────────────────────────────
// Render: Custom Recipes list
// ─────────────────────────────────────────────────────────────────────────
function renderRecipes() {
  const q    = (document.getElementById('recipeSearch')?.value || '').toLowerCase();
  const list = document.getElementById('recipeList');
  const filtered = customRecipes.filter(r =>
    !q || r.resultItem.toLowerCase().includes(q) || (r.name||'').toLowerCase().includes(q));

  if (!filtered.length) {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--parchment-faint);font-family:\'JetBrains Mono\',monospace;font-size:12px">No custom recipes. Use Builder tab.</div>';
    return;
  }

  list.innerHTML = '';
  filtered.forEach(r => {
    const el = document.createElement('div');
    el.className = 'recipe-card';

    let miniGrid = '';
    if (r.grid) {
      miniGrid = '<div class="recipe-mini-grid">';
      for (let i = 0; i < 9; i++) {
        const slot = r.grid[i];
        miniGrid += `<div class="recipe-mini-slot">${slot ? itemImg(slot, '18px') : ''}</div>`;
      }
      miniGrid += '</div>';
    }

    el.innerHTML = `
      <div class="recipe-card-icon">${itemImg(r.resultItem)}</div>
      <div class="recipe-card-info">
        <div class="recipe-card-name">${r.name || r.resultItem.split(':')[1]}</div>
        <div class="recipe-card-id">${r.resultItem} × ${r.resultCount||1}</div>
        <span class="recipe-card-type">${r.recipeType}</span>
      </div>
      ${miniGrid}
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="craftCustom('${r.resultItem}')">⚙ Craft</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRecipe('${encodeURIComponent(r.id)}')">✕</button>
      </div>`;
    list.appendChild(el);
  });
}

async function deleteRecipe(enc) {
  if (!confirm('Delete?')) return;
  const r = await fetch(`${API}/api/custom-recipes/${enc}`, { method: 'DELETE' });
  if ((await r.json()).success) showToast('Deleted', 'success');
  else showToast('Delete failed', 'error');
}

async function craftCustom(itemId) {
  const amount = parseInt(prompt(`How many ${itemId.split(':')[1]}?`, '1')) || 1;
  const r = await fetch(`${API}/api/craft`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ itemId, amount })
  });
  const d = await r.json();
  if (d.success) { showToast(`Queued ${amount}× ${itemId}`, 'success'); switchTab('queue'); }
  else showToast('Failed: ' + d.message, 'error');
}

// ─────────────────────────────────────────────────────────────────────────
// Render: Queue
// ─────────────────────────────────────────────────────────────────────────
function renderQueue() {
  const tbody = document.getElementById('queueBody');
  const empty = document.getElementById('queueEmpty');
  const badge = document.getElementById('queueBadge');
  badge.textContent = craftQueue.length;
  document.getElementById('hGear').classList.toggle('busy', craftQueue.some(j=>j.status==='crafting'));

  const table = document.getElementById('queueTable');
  if (!craftQueue.length) { tbody.innerHTML=''; empty.style.display=''; table.style.display='none'; return; }
  empty.style.display='none'; table.style.display='';
  tbody.innerHTML = '';
  craftQueue.forEach(job => {
    const age = job.startedAt ? Math.round((Date.now()-job.startedAt)/1000)+'s' : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div style="width:32px;height:32px;background:var(--bg-panel-raised);border:1px solid var(--rivet);border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center">
        ${itemImg(job.itemId, '32px')}</div></td>
      <td style="color:var(--parchment)">${job.itemId}</td>
      <td>×${job.amount}</td>
      <td><span class="log-status ${job.status}">${job.status.toUpperCase()}</span></td>
      <td>${age}</td>
      <td>${job.status==='pending'?`<button class="btn btn-danger btn-sm" onclick="cancelJob(${job.id})">Cancel</button>`:'—'}</td>`;
    tbody.appendChild(tr);
  });
}

async function cancelJob(id) {
  await fetch(`${API}/api/queue/${id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  await loadQueue();
}

// ─────────────────────────────────────────────────────────────────────────
// Render: Log
// ─────────────────────────────────────────────────────────────────────────
function renderLog() {
  const list  = document.getElementById('logList');
  const badge = document.getElementById('historyBadge');
  const q     = (document.getElementById('historySearch')?.value || '').toLowerCase();

  badge.textContent = craftLog.length;
  document.getElementById('logCount').textContent = craftLog.length;

  let filtered = q ? craftLog.filter(e=>e.itemId?.toLowerCase().includes(q)) : craftLog;

  if (!filtered.length) {
    list.innerHTML='<div style="text-align:center;padding:40px;color:var(--parchment-faint);font-family:\'JetBrains Mono\',monospace;font-size:12px">No history</div>';
    return;
  }
  list.innerHTML = '';
  filtered.slice(0,100).forEach(entry => {
    const ts  = new Date(entry.completedAt||entry.failedAt||entry.cancelledAt||Date.now());
    const dur = entry.durationMs ? ` · ${(entry.durationMs/1000).toFixed(1)}s` : '';
    const el  = document.createElement('div');
    el.className = `log-entry ${entry.status}`;
    el.innerHTML = `
      <div class="log-icon" style="overflow:hidden">${itemImg(entry.itemId, '32px')}</div>
      <div style="flex:1">
        <div style="color:var(--parchment);font-size:12px">${entry.itemId}</div>
        <div style="color:var(--parchment-faint);font-size:10px">×${entry.amount} · ${ts.toLocaleTimeString()}${dur}</div>
        ${entry.error?`<div style="color:var(--rust);font-size:10px">${entry.error}</div>`:''}
      </div>
      <span class="log-status ${entry.status}">${entry.status.toUpperCase()}</span>`;
    list.appendChild(el);
  });
}

async function clearLog() {
  if (!confirm('Clear all history?')) return;
  await fetch(`${API}/api/log`,{method:'DELETE'});
  craftLog = []; renderLog();
  showToast('Cleared','success');
}

// ─────────────────────────────────────────────────────────────────────────
// CC Log
// ─────────────────────────────────────────────────────────────────────────
let ccLogEntries = [];

async function loadCcLog() {
  try {
    const r = await fetch(`${API}/api/cc-log?limit=200`);
    const d = await r.json();
    ccLogEntries = d.log || [];
    renderCcLog(ccLogEntries);
  } catch {}
}

function renderCcLog(entries) {
  ccLogEntries = entries;
  const list = document.getElementById('ccLogList');
  if (!list) return;

  const status = document.getElementById('ccLogStatus');
  if (status) status.textContent = entries.length + ' lines';

  // Highlight known patterns
  const colorMap = [
    [/\[FAIL\]|\[ERROR\]/i,    '#ff6b6b'],
    [/\[WARN\]/i,               '#ffa94d'],
    [/GOT \d+x|✓|COMPLETED/i, '#69db7c'],
    [/=== JOB|NEW JOB/i,        '#74c0fc'],
    [/Pass \d+\//i,             '#ffd43b'],
    [/Recipe:|Crafter=|Press/i, '#da77f2'],
  ];

  list.innerHTML = entries.slice(-300).map(entry => {
    const msg   = String(entry.msg || entry).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const ts    = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    let color   = '#c8d0d9';
    for (const [pat, col] of colorMap) {
      if (pat.test(msg)) { color = col; break; }
    }
    return `<div style="color:${color};padding:1px 0"><span style="color:#555;margin-right:8px;font-size:10px">${ts}</span>${msg}</div>`;
  }).join('');

  // Auto-scroll to bottom
  list.scrollTop = list.scrollHeight;

  // Flash tab if not active
  const tab = document.getElementById('tabCclog');
  if (tab && !tab.classList.contains('active') && entries.length > 0) {
    tab.style.borderColor = '#ff6b6b';
    setTimeout(() => { tab.style.borderColor = ''; }, 2000);
  }
}

async function clearCcLog() {
  await fetch(`${API}/api/cc-log`, { method: 'DELETE' });
  ccLogEntries = [];
  renderCcLog([]);
}

// ─────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────
function showToast(msg, type) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('leaving'); setTimeout(()=>t.remove(),200); },3200);
}

document.addEventListener('keydown', e => { if (e.key==='Escape') closeItemPicker(); });
init();
