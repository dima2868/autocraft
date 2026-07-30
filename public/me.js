const API_URL = window.location.origin;

let inventory = [];
let craftableItems = {};
let selectedItem = null;
let currentFilter = 'all';
let searchQuery = '';
let craftingQueue = [];

// ══════════════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════════════

async function init() {
    await loadCraftableItems();
    await loadInventory();       // initial fetch
    await loadQueue();           // initial fetch
    setupEventListeners();
    connectSSE();                // live updates via SSE, no polling
}

// ══════════════════════════════════════════════════════════════════════════
// SSE — replaces setInterval polling
// ══════════════════════════════════════════════════════════════════════════

function connectSSE() {
    const es = new EventSource(`${API_URL}/api/events`);

    // inventory update from ComputerCraft
    es.addEventListener('inventory', async () => {
        await loadInventory();
    });

    // queue changed
    es.addEventListener('queue', e => {
        craftingQueue = JSON.parse(e.data);
        renderQueue();
    });

    es.onopen = () => {
        updateStatus(document.getElementById('statusIndicator').classList.contains('online'),
                     null);  // keep existing state
    };
    es.onerror = () => {
        // SSE dropped — try to reconnect automatically (browser does this)
        console.warn('SSE disconnected, reconnecting...');
    };
}

function setupEventListeners() {
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderInventory();
    });
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderInventory();
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════
// API Calls
// ══════════════════════════════════════════════════════════════════════════

async function loadCraftableItems() {
    try {
        const response = await fetch(`${API_URL}/api/items`);
        const data = await response.json();
        
        craftableItems = {};
        data.items.forEach(item => {
            craftableItems[item.id] = item;
        });
        
        console.log(`Loaded ${data.items.length} craftable items`);
    } catch (error) {
        console.error('Error loading craftable items:', error);
    }
}

async function loadInventory() {
    try {
        const response = await fetch(`${API_URL}/api/inventory`);
        const data = await response.json();

        if (data.online) {
            // Live inventory from ComputerCraft.
            // Note: items may legitimately be an empty array (empty storage) — that is
            // NOT the same as CC being offline, so we must not fall back here.
            inventory = Array.isArray(data.items) ? data.items : [];
            console.log(`[inventory] online, ${inventory.length} items, totalItems=${data.stats?.totalItems ?? '?'}`);
            updateStatus(true, data);
            renderInventory();
        } else {
            // CC truly offline — fall back to showing craftable items from recipes
            console.log('[inventory] CC offline, loading craftable items...');
            await loadCraftableItemsAsInventory();
            updateStatus(false);
        }
    } catch (error) {
        console.error('Error loading inventory:', error);
        await loadCraftableItemsAsInventory();
        updateStatus(false);
    }
}

async function loadCraftableItemsAsInventory() {
    try {
        const response = await fetch(`${API_URL}/api/items`);
        const data = await response.json();
        
        // Convert craftable items to inventory format
        inventory = data.items.map(item => ({
            id: item.id,
            name: item.name,
            namespace: item.namespace,
            count: 0, // Unknown count (not in storage)
            locations: 0
        }));
        
        renderInventory();
    } catch (error) {
        console.error('Error loading craftable items:', error);
    }
}

async function loadQueue() {
    try {
        const response = await fetch(`${API_URL}/api/queue`);
        const data = await response.json();
        craftingQueue = data.queue || [];
        renderQueue();
    } catch (error) {
        console.error('Error loading queue:', error);
    }
}

async function craftItem(itemId, amount) {
    try {
        const response = await fetch(`${API_URL}/api/craft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId, amount })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Crafting ${amount}x ${itemId}`, 'success');
            loadQueue();
        } else {
            showNotification(`Failed: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error crafting item:', error);
        showNotification('Craft request failed', 'error');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Rendering
// ══════════════════════════════════════════════════════════════════════════

function renderInventory() {
    const grid = document.getElementById('itemGrid');
    
    // Filter items
    let filteredItems = inventory.filter(item => {
        // Search filter
        if (searchQuery && !item.id.toLowerCase().includes(searchQuery) && 
            !item.name.toLowerCase().includes(searchQuery)) {
            return false;
        }
        
        // Namespace filter
        if (currentFilter !== 'all' && currentFilter !== 'craftable') {
            if (item.namespace !== currentFilter) return false;
        }
        
        // Craftable filter
        if (currentFilter === 'craftable') {
            if (!craftableItems[item.id]) return false;
        }
        
        return true;
    });
    
    // Sort by count (descending)
    filteredItems.sort((a, b) => b.count - a.count);
    
    // Render
    grid.innerHTML = '';
    
    if (filteredItems.length === 0) {
        grid.innerHTML = '<div class="no-items">No items found</div>';
        document.getElementById('gridCount').textContent = '0 items';
        return;
    }
    
    filteredItems.forEach(item => {
        const card = createItemCard(item);
        grid.appendChild(card);
    });
    
    document.getElementById('gridCount').textContent = `${filteredItems.length} items`;
}

function createItemCard(item) {
    const card = document.createElement('div');
    card.className = 'item-card';
    if (selectedItem && selectedItem.id === item.id) {
        card.classList.add('selected');
    }
    
    const icon = document.createElement('div');
    icon.className = 'item-icon';
    
    // Build texture URL — try craftableItems first, then guess path
    const texture = craftableItems[item.id]?.texture;
    const texPath = texture
        ? '/' + texture
        : guessTexPath(item.id);

    if (texPath) {
        const img = document.createElement('img');
        img.src = texPath;
        img.onerror = () => { 
            icon.innerHTML = getNamespaceEmoji(item.namespace);
            icon.classList.add('missing');
        };
        icon.appendChild(img);
    } else {
        icon.innerHTML = getNamespaceEmoji(item.namespace);
        icon.classList.add('missing');
    }
    
    // Only show count badge if item is in storage (count > 0)
    if (item.count > 0) {
        const count = document.createElement('div');
        count.className = 'item-count';
        count.textContent = formatCount(item.count);
        icon.appendChild(count);
    }
    
    const name = document.createElement('div');
    name.className = 'item-name';
    name.textContent = item.name;
    name.title = item.id; // Show full ID on hover
    
    card.appendChild(icon);
    card.appendChild(name);
    
    card.addEventListener('click', () => {
        selectedItem = item;
        showItemDetails(item);
        document.querySelectorAll('.item-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
    });
    
    return card;
}

function showItemDetails(item) {
    const content = document.getElementById('detailsContent');
    
    const texture = craftableItems[item.id]?.texture;
    const texPath = texture ? '/' + texture : guessTexPath(item.id);
    const isCraftable = !!craftableItems[item.id];
    const inStorage = item.count > 0;
    
    content.innerHTML = `
        <div class="item-details">
            <div class="detail-icon">
                ${texPath ? `<img src="${texPath}" style="width:100%;height:100%;image-rendering:pixelated" onerror="this.parentElement.innerHTML=getNamespaceEmoji('${item.namespace}')">` : getNamespaceEmoji(item.namespace)}
            </div>
            <div class="detail-name">${item.name}</div>
            <div class="detail-id">${item.id}</div>
            
            <div class="detail-stats">
                <div class="stat-row">
                    <span class="stat-label">In Storage:</span>
                    <span class="stat-value">${inStorage ? item.count : 'Not in storage'}</span>
                </div>
                ${inStorage ? `
                <div class="stat-row">
                    <span class="stat-label">Locations:</span>
                    <span class="stat-value">${item.locations}</span>
                </div>
                ` : ''}
                <div class="stat-row">
                    <span class="stat-label">Namespace:</span>
                    <span class="stat-value">${item.namespace}</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Craftable:</span>
                    <span class="stat-value">${isCraftable ? 'Yes' : 'No'}</span>
                </div>
            </div>
            
            <button class="craft-btn" ${!isCraftable ? 'disabled' : ''} onclick="openCraftModal('${item.id}')">
                ${isCraftable ? '⚙ Craft Item' : 'Not Craftable'}
            </button>
        </div>
    `;
}

function renderQueue() {
    const queueList = document.getElementById('queueList');
    const queueCount = document.getElementById('queueCount');
    const headerGear = document.getElementById('headerGear');

    const hasActiveJob = craftingQueue.some(job => job.status === 'crafting');
    if (headerGear) {
        headerGear.classList.toggle('busy', hasActiveJob);
    }

    if (craftingQueue.length === 0) {
        queueList.innerHTML = '<div class="queue-empty">No crafting jobs</div>';
        queueCount.textContent = '0 active';
        return;
    }
    
    queueList.innerHTML = '';
    
    craftingQueue.forEach(job => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        if (job.status === 'crafting') {
            item.classList.add('active');
        }
        
        const texture = craftableItems[job.itemId]?.texture;
        const isCrafting = job.status === 'crafting';
        
        item.innerHTML = `
            <div class="queue-icon">
                ${texture ? `<img src="/${texture}" onerror="this.parentElement.innerHTML='⚙️'">` : '⚙️'}
                ${isCrafting ? '<span class="mini-cog">⚙</span>' : ''}
            </div>
            <div class="queue-info">
                <div class="queue-item-name">${job.itemId.split(':')[1] || job.itemId}</div>
                <div class="queue-status">${job.status.toUpperCase()} · ${job.amount}x</div>
            </div>
            ${job.status === 'pending' ? `<button class="queue-cancel-btn" onclick="cancelCraft(${job.id})">✕</button>` : ''}
        `;
        
        queueList.appendChild(item);
    });
    
    queueCount.textContent = `${craftingQueue.length} active`;
}

async function cancelCraft(jobId) {
    try {
        const response = await fetch(`${API_URL}/api/queue/${jobId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Craft job #${jobId} cancelled`, 'success');
            loadQueue();
        } else {
            showNotification(`Failed to cancel: ${data.message}`, 'error');
        }
    } catch (error) {
        console.error('Error cancelling craft:', error);
        showNotification('Failed to cancel craft', 'error');
    }
}

function updateStatus(online, data = null) {
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    const itemCount = document.getElementById('itemCount');
    const storageCount = document.getElementById('storageCount');
    
    if (online) {
        indicator.classList.add('online');
        statusText.textContent = 'ONLINE';
        
        if (data) {
            // Show total item count (all pieces), not unique item count
            itemCount.textContent = data.stats?.totalItems 
                ? formatCount(data.stats.totalItems) 
                : (data.items?.length || 0);
            storageCount.textContent = data.stats?.storageDevices || 0;
        }
    } else {
        indicator.classList.remove('online');
        statusText.textContent = 'OFFLINE';
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Craft Modal
// ══════════════════════════════════════════════════════════════════════════

async function openCraftModal(itemId) {
    const modal = document.getElementById('craftModal');
    const body = document.getElementById('craftModalBody');
    
    body.innerHTML = '<div class="modal-loading">Loading recipe data...</div>';
    modal.classList.add('show');
    
    try {
        const safeId = itemId.replace(':', '__');
        const response = await fetch(`${API_URL}/api/recipes/${safeId}`);
        const data = await response.json();
        
        if (!data.recipes || data.recipes.length === 0) {
            body.innerHTML = '<div class="modal-error">No recipes found for this item</div>';
            return;
        }
        
        const recipe = data.recipes[0];
        const texture = craftableItems[itemId]?.texture;
        
        body.innerHTML = `
            <div class="modal-icon-frame">
                ${texture ? `<img src="/${texture}" style="width:100%;height:100%;image-rendering:pixelated;" onerror="this.parentElement.innerHTML='⚙️'">` : '⚙️'}
            </div>
            <div class="modal-item-name">${itemId.split(':')[1] || itemId}</div>
            <div class="modal-item-id">${itemId}</div>
            
            <div class="modal-recipe-box">
                <div class="rlabel">Recipe Type</div>
                <div class="rvalue">${recipe.type}</div>
            </div>
            
            <label class="modal-amount-label">Amount</label>
            <input type="number" id="craftAmount" class="modal-amount-input" value="1" min="1" max="64">
            
            <button onclick="submitCraft('${itemId}')" class="craft-btn">
                ⚙ Start Crafting
            </button>
        `;
    } catch (error) {
        body.innerHTML = '<div class="modal-error">Error loading recipe</div>';
    }
}

function closeCraftModal() {
    document.getElementById('craftModal').classList.remove('show');
}

async function submitCraft(itemId) {
    const amount = parseInt(document.getElementById('craftAmount').value) || 1;
    closeCraftModal();
    await craftItem(itemId, amount);
}

// ══════════════════════════════════════════════════════════════════════════
// Polling — REMOVED, replaced by SSE above
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════════════════

function formatCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

// Guess texture path from item id (works for all 1668 items in our DB)
function guessTexPath(itemId) {
    if (!itemId) return null;
    const ns   = itemId.split(':')[0];
    const name = itemId.split(':')[1];
    if (!ns || !name) return null;
    return `/textures/${ns}__${name}.png`;
}

function getNamespaceEmoji(ns) {
    const icons = {
        'minecraft': '🟩',
        'create': '⚙️',
        'tfmg': '🏭',
        'createaddition': '⚡',
        'createbigcannons': '💣',
        'farmersdelight': '🌾',
        'createdeco': '🏗️',
    };
    return icons[ns] || '📦';
}

function showNotification(message, type) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 200);
    }, 3200);
}

// Close modal on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeCraftModal();
    }
});

// Close modal on background click
document.getElementById('craftModal').addEventListener('click', (e) => {
    if (e.target.id === 'craftModal') {
        closeCraftModal();
    }
});

// ══════════════════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════════════════

init();
