-- ══════════════════════════════════════════════════════════════════════════
-- ME Terminal Bridge v4.0
-- Multi-crafter (4× vanilla minecraft:crafter) · 2 input + 2 output barrels
-- Reads hardware config from the web server · reports peripherals
-- Output barrel → (optional) item_vault as final storage
-- ══════════════════════════════════════════════════════════════════════════

local API_URL = "https://autocraft-production.up.railway.app"  -- ← change to your URL
local SYNC_INTERVAL = 2          -- inventory push every N seconds
local PERIPH_REPORT_INTERVAL = 10 -- peripheral report every N seconds
local CRAFTER_POLL_INTERVAL = 3   -- each worker polls queue every N seconds

local HEADERS = {
    ["Content-Type"]="application/json"
}

-- Runtime config (fetched from /api/config)
local CONFIG = { crafters={}, vault="", autoMoveToVault=true }

-- ══ Remote log ══════════════════════════════════════════════════════════
local logBuf = {}
local COLOR = {
    info=colors.white, ok=colors.lime, warn=colors.orange,
    error=colors.red,  cyan=colors.cyan, yellow=colors.yellow
}

function log(msg, level)
    level = level or "info"
    term.setTextColor(COLOR[level] or colors.white)
    print(msg)
    term.setTextColor(colors.white)
    table.insert(logBuf, msg)
    if #logBuf >= 8 then flushLog() end
end

function flushLog()
    if #logBuf == 0 then return end
    local lines = logBuf; logBuf = {}
    pcall(function()
        local r = http.post(API_URL.."/api/cc-log",
            textutils.serialiseJSON({lines=lines}), HEADERS)
        if r then r.close() end
    end)
end

-- ══ JSON encoding (manual, robust — avoids textutils quirks) ════════════
-- Encodes a value to a JSON string. Handles nil/string/number/boolean/array/table.
local function jsonEscape(s)
    s = tostring(s)
    s = s:gsub('\\','\\\\'):gsub('"','\\"'):gsub('\n','\\n'):gsub('\r','\\r'):gsub('\t','\\t')
    return s
end

local function isIntArray(t)
    local n = 0
    for _ in pairs(t) do n = n + 1 end
    if n == 0 then return true end  -- empty table → treat as array []
    for i = 1, n do if t[i] == nil then return false end end
    return true
end

local function jsonEncode(v)
    local tv = type(v)
    if v == nil then return "null"
    elseif tv == "string" then return '"'..jsonEscape(v)..'"'
    elseif tv == "number" then
        if v ~= v or v == math.huge or v == -math.huge then return "0" end
        return tostring(v)
    elseif tv == "boolean" then return v and "true" or "false"
    elseif tv ~= "table" then return "null"
    end
    if isIntArray(v) then
        local parts = {}
        for i = 1, #v do parts[i] = jsonEncode(v[i]) end
        return "["..table.concat(parts, ",").."]"
    else
        local parts = {}
        for k, val in pairs(v) do
            if type(k) == "string" then
                parts[#parts+1] = '"'..jsonEscape(k)..'":'..jsonEncode(val)
            end
        end
        return "{"..table.concat(parts, ",").."}"
    end
end

-- ══ HTTP ═════════════════════════════════════════════════════════════════
function httpGet(path)
    local url = API_URL .. path
    local ok, r = pcall(http.get, url, HEADERS)
    if not ok or not r then
        local httpUrl = url:gsub("^https:", "http:")
        ok, r = pcall(http.get, httpUrl, HEADERS)
    end
    if not ok or not r then return nil end
    local b = r.readAll(); r.close()
    return textutils.unserialiseJSON(b)
end

function httpPost(path, data)
    local body = type(data)=="string" and data or jsonEncode(data)
    local url = API_URL .. path
    local ok, r = pcall(http.post, url, body, HEADERS)
    if not ok or not r then
        local httpUrl = url:gsub("^https:", "http:")
        ok, r = pcall(http.post, httpUrl, body, HEADERS)
    end
    if ok and r then local b = r.readAll(); r.close()
        if b and #b > 0 then return textutils.unserialiseJSON(b) end
        return { ok = true }
    end
    return nil
end

-- ══ Config & peripherals ═════════════════════════════════════════════════
function loadConfig()
    local d = httpGet("/api/config")
    if d and d.config then
        CONFIG = d.config
        log("Config loaded: "..#CONFIG.crafters.." crafters, vault="..(CONFIG.vault or "none"),"cyan")
        return true
    end
    log("WARN: could not load config from server","warn")
    return false
end

function reportPeripherals()
    local list = {}
    for _, name in ipairs(peripheral.getNames()) do
        local pt = peripheral.getType(name)
        table.insert(list, { name = name, type = pt or "unknown" })
    end
    httpPost("/api/peripherals", { peripherals = list })
    return #list
end

-- ══ Storage scan ════════════════════════════════════════════════════════
function findAllStorage()
    local devices = {}
    for _, name in ipairs(peripheral.getNames()) do
        local pt = peripheral.getType(name)
        if pt and (pt:find("vault") or pt:find("chest") or pt:find("barrel") or pt == "inventory") then
            local p = peripheral.wrap(name)
            if p and p.list then
                table.insert(devices, { name=name, type=pt, p=p })
            end
        end
    end
    return devices
end

function scanInventory()
    local inv, totalItems, totalStacks = {}, 0, 0
    for _, d in ipairs(findAllStorage()) do
        local ok, items = pcall(function() return d.p.list() end)
        if ok and items then
            for slot, item in pairs(items) do
                local id = item.name
                if not inv[id] then
                    inv[id] = {
                        id=id,
                        name = id:match(":(.+)") or id,
                        namespace = id:match("^(.+):") or "minecraft",
                        totalCount = 0,
                        locations = 0
                    }
                end
                inv[id].totalCount = inv[id].totalCount + item.count
                inv[id].locations = inv[id].locations + 1
                totalItems = totalItems + item.count
                totalStacks = totalStacks + 1
            end
        end
    end
    return inv, { totalItems=totalItems, totalStacks=totalStacks, storageDevices=#findAllStorage() }
end

function pushInventory(inv, stats)
    local items = {}
    for _, d in pairs(inv) do
        table.insert(items, {
            id=d.id, name=d.name, namespace=d.namespace,
            count=d.totalCount, locations=d.locations
        })
    end
    table.sort(items, function(a,b) return a.count > b.count end)
    local resp = httpPost("/api/inventory", {
        computerId=os.getComputerID(),
        timestamp=os.epoch("utc"),
        stats=stats,
        items=items
    })
    log("Inventory pushed: "..#items.." items, totalItems="..(stats.totalItems or 0))
    return resp
end

-- ══ Item search (direct id or #tag resolution) ══════════════════════════
function findItem(itemId)
    local isTag = itemId:sub(1,1) == "#"
    local tag = isTag and itemId:sub(2) or nil
    local best = nil
    for _, dev in ipairs(findAllStorage()) do
        local ok, items = pcall(function() return dev.p.list() end)
        if ok and items then
            for slot, item in pairs(items) do
                if not isTag then
                    if item.name == itemId then return dev.name, slot, item.count end
                else
                    -- Heuristic tag match: c:ingots/iron -> *_ingot ending in "iron"
                    local sim = tag:gsub("^c:",""):gsub("^forge:","")
                    local base = sim:match("([^/]+)$") or sim
                    local pats = { base }
                    if sim:match("^ingots/") then pats = { base.."_ingot" }
                    elseif sim:match("^plates/") or sim:match("^sheets/") then pats = { base.."_plate", base.."_sheet" }
                    elseif sim:match("^nuggets/") then pats = { base.."_nugget" }
                    elseif sim:match("^dusts/") then pats = { base.."_dust" }
                    elseif sim:match("^gears/") then pats = { base.."_gear" }
                    elseif sim:match("^rods/") or sim:match("^sticks/") then pats = { base.."_rod", base.."_stick" }
                    end
                    local ibase = item.name:match(":(.+)") or item.name
                    for _, pat in ipairs(pats) do
                        if ibase == pat or ibase:match(pat.."$") then
                            local prio = item.name:match("^minecraft:") and 1
                                or item.name:match("^create:") and 2 or 10
                            if not best or prio < best.prio then
                                best = { storage=dev.name, slot=slot, count=item.count, prio=prio }
                            end
                            break
                        end
                    end
                end
            end
        end
    end
    if best then return best.storage, best.slot, best.count end
    return nil
end

-- ══ Transfer helpers ═════════════════════════════════════════════════════
-- Move 1 item from storage into a target crafter slot.
function moveItemToSlot(targetName, targetSlot, itemId)
    local src, srcSlot = findItem(itemId)
    if not src then return false, "missing: "..itemId end
    local sp = peripheral.wrap(src)
    if not sp then return false, "cannot wrap "..src end
    local ok, moved = pcall(function() return sp.pushItems(targetName, srcSlot, 1, targetSlot) end)
    if not ok or not moved or moved == 0 then
        return false, "transfer failed "..itemId.." -> "..targetName.."#"..targetSlot
    end
    return true, moved
end

-- Pull all items from a peripheral (output barrel) into the vault.
function moveToVault(periphName)
    if not CONFIG.vault or CONFIG.vault == "" then return end
    local vault = peripheral.wrap(CONFIG.vault)
    local src = peripheral.wrap(periphName)
    if not vault or not src then return end
    local moved = 0
    for slot, item in pairs(src.list()) do
        local ok, n = pcall(function() return vault.pullItems(periphName, slot, item.count) end)
        if ok and n then moved = moved + n end
        sleep(0.05)
    end
    if moved > 0 then log("  → vault: "..moved.." items moved","ok") end
end

function clearCrafter(crafterName)
    local cr = peripheral.wrap(crafterName)
    if not cr then return end
    for slot in pairs(cr.list()) do
        pcall(function() cr.pushItems(crafterName, slot, 64) end)
        -- Crafter has no own inventory to dump into; eject into first output barrel
        for _, c in ipairs(CONFIG.crafters or {}) do
            if c.crafter == crafterName and c.outputs and c.outputs[1] and c.outputs[1] ~= "" then
                pcall(function() cr.pushItems(c.outputs[1], slot, 64) end)
                break
            end
        end
        sleep(0.05)
    end
end

-- ══ Redstone pulse on the crafter ═════════════════════════════════════════
-- The crafter is a peripheral; we pulse it via the computer's side facing it
-- (redstoneSide) or via a redstone_relay peripheral (redstonePeripheral).
local function waitTicks(seconds)
    local id = os.startTimer(seconds)
    while true do
        local event, timerId = os.pullEvent("timer")
        if timerId == id then break end
    end
end

function pulseCraft(c)
    local side = c.redstoneSide or "left"
    if c.redstonePeripheral and c.redstonePeripheral ~= "" then
        local relay = peripheral.wrap(c.redstonePeripheral)
        if relay and relay.setOutput then
            relay.setOutput(side, true); waitTicks(0.05); relay.setOutput(side, false)
            waitTicks(0.1); return
        end
        log("WARN: relay "..c.redstonePeripheral.." missing setOutput","warn")
    end
    pcall(function() redstone.setOutput(side, true) end)
    waitTicks(0.05)
    pcall(function() redstone.setOutput(side, false) end)
    waitTicks(0.1)
end

-- ══ Recipe fetch (grid comes pre-built from server) ═══════════════════════
function getRecipe(itemId)
    local d = httpGet("/api/recipes/" .. itemId:gsub(":", "__"))
    if d and d.recipes then
        for _, r in ipairs(d.recipes) do
            if r.craft and r.craft.grid and r.craft.mode == "crafter" then
                -- Prefer a crafter-mode recipe with a real grid
                local filled = 0
                for i = 1, 9 do if r.craft.grid[i] then filled = filled + 1 end end
                if filled > 0 then return r end
            end
        end
        -- Fallback: first recipe of any kind
        if #d.recipes > 0 then return d.recipes[1] end
    end
    return nil
end

-- ══ Craft execution for one crafter ═══════════════════════════════════════
function runCraft(job, c)
    local recipe = getRecipe(job.itemId)
    if not recipe or not recipe.craft or not recipe.craft.grid then
        return false, "no crafter recipe for "..job.itemId
    end
    if recipe.craft.mode ~= "crafter" then
        return false, "recipe mode '"..(recipe.craft.mode or "?").."' not supported by vanilla crafter"
    end

    local grid = recipe.craft.grid
    local resultCount = recipe.craft.resultCount or 1
    local passes = math.ceil(job.amount / resultCount)
    local crafterName = c.crafter
    local outBarrels = {}
    for _, b in ipairs(c.outputs or {}) do if b and b ~= "" then outBarrels[#outBarrels+1] = b end end
    if #outBarrels == 0 then return false, "no output barrels configured for crafter "..crafterName end

    local cr = peripheral.wrap(crafterName)
    if not cr then return false, "cannot wrap crafter "..crafterName end

    log("["..crafterName.."] "..passes.." passes × "..resultCount.." = "..job.amount.."x "..job.itemId, "yellow")

    local totalCrafted = 0
    for pass = 1, passes do
        log("  pass "..pass.."/"..passes)
        clearCrafter(crafterName)

        -- Load the 9 slots
        for slotIdx = 1, 9 do
            local itemId = grid[slotIdx]
            if itemId then
                local ok, err = moveItemToSlot(crafterName, slotIdx, itemId)
                if not ok then
                    clearCrafter(crafterName)
                    return false, err
                end
                log("    slot "..slotIdx.." <- "..itemId)
                sleep(0.1)
            end
        end

        -- Verify fill
        local filled = 0
        for _ in pairs(cr.list()) do filled = filled + 1 end
        if filled == 0 then return false, "crafter empty after fill" end

        -- Pulse
        log("    RS pulse -> "..(c.redstonePeripheral ~= "" and c.redstonePeripheral or (c.redstoneSide or "left")))
        pulseCraft(c)

        -- Wait for output in any output barrel
        local got = false
        for t = 1, 12 do
            sleep(0.5)
            for _, ob in ipairs(outBarrels) do
                local bp = peripheral.wrap(ob)
                if bp then
                    for _, itm in pairs(bp.list()) do
                        if itm.name == job.itemId then
                            totalCrafted = totalCrafted + itm.count
                            log("    GOT "..itm.count.."x "..itm.name, "ok")
                            got = true; break
                        end
                    end
                end
                if got then break end
            end
            if got then break end
        end

        if not got then
            log("    WARN: no output after 6s, continuing", "warn")
        end

        flushLog()
        -- Move output barrel(s) → vault
        if CONFIG.autoMoveToVault then
            for _, ob in ipairs(outBarrels) do moveToVault(ob) end
        end
        sleep(0.1)
    end

    log("["..crafterName.."] DONE: "..totalCrafted.."x "..job.itemId, "ok")
    flushLog()
    return true
end

-- ══ Worker: one per crafter ═══════════════════════════════════════════════
function makeWorker(c)
    return function()
        sleep(1 + c.id * 0.5)  -- stagger startup to avoid 4 simultaneous queue polls
        log("Worker #"..c.id.." started: "..c.crafter, "cyan")
        while true do
            local ok, data = pcall(httpGet, "/api/queue/next?crafterId="..c.id)
            if ok and data and data.job then
                local job = data.job
                log("["..c.crafter.."] JOB #"..job.id.." "..job.amount.."x "..job.itemId, "cyan")
                local success, err = pcall(function()
                    local rok, rerr = runCraft(job, c)
                    if rok then
                        httpPost("/api/queue/"..job.id.."/complete", {})
                        log("["..c.crafter.."] JOB #"..job.id.." COMPLETED", "ok")
                    else
                        httpPost("/api/queue/"..job.id.."/fail", { error = rerr or "unknown" })
                        log("["..c.crafter.."] JOB #"..job.id.." FAILED: "..(rerr or "?"), "error")
                    end
                end)
                if not ok then
                    httpPost("/api/queue/"..job.id.."/fail", { error = tostring(err) })
                    log("["..c.crafter.."] JOB #"..job.id.." CRASH: "..tostring(err), "error")
                end
                flushLog()
            end
            -- wait before next poll
            local tid = os.startTimer(CRAFTER_POLL_INTERVAL)
            while true do
                local _, id = os.pullEvent("timer")
                if id == tid then break end
            end
        end
    end
end

-- ══ Inventory sync task ═══════════════════════════════════════════════════
local lastStats = { totalItems=0, totalStacks=0, storageDevices=0 }

function taskInventorySync()
    local inv, stats = scanInventory()
    lastStats = stats
    pcall(pushInventory, inv, stats)
    redraw()
    while true do
        local tid = os.startTimer(SYNC_INTERVAL)
        while true do
            local _, id = os.pullEvent("timer")
            if id == tid then break end
        end
        local inv2, stats2 = scanInventory()
        lastStats = stats2
        pcall(pushInventory, inv2, stats2)
        redraw()
    end
end

-- ══ Peripheral report task ════════════════════════════════════════════════
function taskPeriphReport()
    while true do
        local n = reportPeripherals()
        log("Peripherals reported: "..n)
        local tid = os.startTimer(PERIPH_REPORT_INTERVAL)
        while true do
            local _, id = os.pullEvent("timer")
            if id == tid then break end
        end
    end
end

-- ══ Display ═══════════════════════════════════════════════════════════════
local craftCount = 0

function redraw()
    term.setBackgroundColor(colors.black); term.clear(); term.setCursorPos(1,1)
    term.setBackgroundColor(colors.gray); term.setTextColor(colors.white)
    term.clearLine(); term.write("  ME TERMINAL v4.0 — 4-CRAFTER  ")
    term.setBackgroundColor(colors.black)
    term.setCursorPos(1,3); term.setTextColor(colors.yellow)
    print("Storage  : "..lastStats.storageDevices.." devices")
    term.setTextColor(colors.cyan)
    print("Items    : "..lastStats.totalItems.." | Stacks: "..lastStats.totalStacks)
    term.setCursorPos(1,5); term.setTextColor(colors.lime)
    print("Crafters : "..#CONFIG.crafters.." configured")
    local y = 6
    for _, c in ipairs(CONFIG.crafters) do
        if c.crafter and c.crafter ~= "" then
            term.setTextColor(c.enabled and colors.lime or colors.gray)
            print("  #"..c.id.." "..c.crafter..(c.enabled and " [ON]" or " [off]"))
            y = y + 1
        end
    end
    term.setCursorPos(1, y+1); term.setTextColor(colors.lightBlue)
    print(API_URL.."/crafts.html")
    term.setCursorPos(1, y+3); term.setTextColor(colors.white)
    print("R=rescan  Ctrl+T=stop")
end

function taskInput()
    while true do
        local _, key = os.pullEvent("key")
        if key == keys.r then
            local inv, stats = scanInventory()
            lastStats = stats
            pcall(pushInventory, inv, stats)
            redraw()
        end
    end
end

-- ══ Startup ═══════════════════════════════════════════════════════════════
term.setBackgroundColor(colors.black); term.clear(); term.setCursorPos(1,1)
term.setTextColor(colors.yellow)
print("ME Terminal v4.0 starting...")
print("Logs: "..API_URL.."/crafts.html (CC Log tab)")
print("Testing connection to "..API_URL)

local ok, connErr = pcall(function()
    local r, e = http.get(API_URL.."/api/stats", HEADERS)
    if not r then error(e or "no response object") end
    local body = r.readAll(); r.close()
    if not body or #body == 0 then error("empty response") end
end)
if not ok then
    term.setTextColor(colors.red)
    print("ERROR: Cannot connect to API!")
    print("Reason: "..tostring(connErr))
    print("URL: "..API_URL)
    print("Try in CC prompt: http.get(\""..API_URL.."/api/stats\")")
    return
end
term.setTextColor(colors.lime); print("Connected!")
sleep(0.5)

loadConfig()
reportPeripherals()

-- Build worker tasks only for enabled, configured crafters
local tasks = { taskInventorySync, taskPeriphReport, taskInput }
for _, c in ipairs(CONFIG.crafters) do
    if c.enabled and c.crafter and c.crafter ~= "" then
        tasks[#tasks+1] = makeWorker(c)
    end
end

if #tasks == 3 then
    log("WARN: no crafters enabled/configured — set them up in Craft Manager → Setup", "warn")
end

parallel.waitForAll(table.unpack(tasks))
