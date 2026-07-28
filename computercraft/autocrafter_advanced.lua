-- ══════════════════════════════════════════════════════════════════════════
-- Create AutoCraft - Advanced Crafting System
-- Manages mechanical crafters, presses, and depot routing
-- ══════════════════════════════════════════════════════════════════════════

local API_URL = "https://me-terminal-production.up.railway.app"

-- HTTP headers for Railway bypass
local HTTP_HEADERS = {
    ["Content-Type"] = "application/json",
    ["bypass-tunnel-reminder"] = "true",
    ["ngrok-skip-browser-warning"] = "true"
}

-- ══════════════════════════════════════════════════════════════════════════
-- Device Registry
-- ══════════════════════════════════════════════════════════════════════════

local devices = {
    depots = {},         -- Input depots (depot_1, depot_2, depot_3)
    crafters = {},       -- Mechanical crafters 3x3 grid
    output_depot = nil,  -- Output depot (depot_4)
    storage = {},        -- Storage chests
    computer = nil       -- Main computer
}

-- Scan and register all connected peripherals
function scanDevices()
    print("Scanning network...")
    devices.depots = {}
    devices.crafters = {}
    devices.storage = {}
    
    for _, name in ipairs(peripheral.getNames()) do
        local ptype = peripheral.getType(name)
        
        -- Depots for press input
        if name:match("depot_%d+$") then
            table.insert(devices.depots, {name = name, peripheral = peripheral.wrap(name)})
            print("  [DEPOT] " .. name)
        
        -- Output depot
        elseif name:match("depot_4$") then
            devices.output_depot = {name = name, peripheral = peripheral.wrap(name)}
            print("  [OUTPUT] " .. name)
        
        -- Mechanical crafters (3x3 grid)
        elseif name:match("mechanical_crafter_%d+$") then
            local num = tonumber(name:match("%d+"))
            table.insert(devices.crafters, {
                name = name,
                peripheral = peripheral.wrap(name),
                slot = num  -- 1-9 for 3x3 grid
            })
            print("  [CRAFTER] " .. name)
        
        -- Create Item Vaults (item_vault_5, item_vault_6, etc.)
        elseif name:match("item_vault_%d+$") then
            table.insert(devices.storage, {name = name, peripheral = peripheral.wrap(name)})
            print("  [VAULT] " .. name)
        
        -- Storage chests (fallback)
        elseif ptype:find("chest") or ptype == "inventory" then
            table.insert(devices.storage, {name = name, peripheral = peripheral.wrap(name)})
            print("  [STORAGE] " .. name)
        end
    end
    
    -- Sort crafters by slot number
    table.sort(devices.crafters, function(a, b) return a.slot < b.slot end)
    
    print("\nFound:")
    print("  " .. #devices.depots .. " press depots")
    print("  " .. #devices.crafters .. " mechanical crafters")
    print("  " .. (devices.output_depot and "1" or "0") .. " output depot")
    print("  " .. #devices.storage .. " storage vaults/chests")
end

-- ══════════════════════════════════════════════════════════════════════════
-- API Communication
-- ══════════════════════════════════════════════════════════════════════════

function apiGet(endpoint)
    local url = API_URL .. endpoint
    local ok, response = pcall(http.get, url, HTTP_HEADERS)
    if not ok or not response then
        local httpUrl = url:gsub("^https:", "http:")
        ok, response = pcall(http.get, httpUrl, HTTP_HEADERS)
    end
    if not ok or not response then return nil, "Connection failed" end
    local data = response.readAll()
    response.close()
    return textutils.unserialiseJSON(data)
end

function getRecipeData(itemId)
    local safeId = itemId:gsub(":", "__")
    return apiGet("/api/recipes/" .. safeId)
end

-- ══════════════════════════════════════════════════════════════════════════
-- Inventory Management
-- ══════════════════════════════════════════════════════════════════════════

-- Find item in storage
function findItemInStorage(itemId)
    for _, storage in ipairs(devices.storage) do
        for slot, item in pairs(storage.peripheral.list()) do
            if item.name == itemId then
                return storage, slot, item.count
            end
        end
    end
    return nil
end

-- Transfer item from storage to target
function transferItem(itemId, targetName, targetSlot, amount)
    local storage, slot, available = findItemInStorage(itemId)
    if not storage then
        return false, "Item not found: " .. itemId
    end
    
    local count = math.min(amount or 1, available)
    local moved = storage.peripheral.pushItems(targetName, slot, count, targetSlot)
    
    if moved > 0 then
        return true, moved
    else
        return false, "Transfer failed"
    end
end

-- ══════════════════════════════════════════════════════════════════════════
-- Crafting Logic
-- ══════════════════════════════════════════════════════════════════════════

-- Parse shaped crafting recipe (3x3 grid)
function parseShapedRecipe(recipeData)
    local pattern = recipeData.pattern or {}
    local key = recipeData.key or {}
    local grid = {}
    
    for row = 1, 3 do
        for col = 1, 3 do
            local index = (row - 1) * 3 + col
            local patternChar = pattern[row] and pattern[row]:sub(col, col) or " "
            
            if patternChar ~= " " and key[patternChar] then
                local ingredient = key[patternChar]
                local itemId = ingredient.item or (ingredient[1] and ingredient[1].item)
                grid[index] = itemId
            else
                grid[index] = nil
            end
        end
    end
    
    return grid
end

-- Parse mechanical crafting recipe (Create mod)
function parseMechanicalRecipe(recipeData)
    local pattern = recipeData.pattern or {}
    local key = recipeData.key or {}
    local grid = {}
    
    -- Mechanical crafting can be larger than 3x3, but we support 3x3
    for row = 1, math.min(3, #pattern) do
        for col = 1, math.min(3, #pattern[row]) do
            local index = (row - 1) * 3 + col
            local patternChar = pattern[row]:sub(col, col)
            
            if patternChar ~= " " and key[patternChar] then
                local ingredient = key[patternChar]
                local itemId = ingredient.item or ingredient.tag
                grid[index] = itemId
            else
                grid[index] = nil
            end
        end
    end
    
    return grid
end

-- Execute crafting process
function craftItem(itemId, recipe)
    print("\n=== Crafting: " .. itemId .. " ===")
    print("Recipe type: " .. recipe.type)
    
    local grid = {}
    
    -- Parse recipe based on type
    if recipe.type == "minecraft:crafting_shaped" then
        grid = parseShapedRecipe(recipe.data)
    elseif recipe.type == "create:mechanical_crafting" then
        grid = parseMechanicalRecipe(recipe.data)
    else
        return false, "Unsupported recipe type: " .. recipe.type
    end
    
    -- Display grid
    print("\nCrafting grid:")
    for row = 1, 3 do
        local line = "  "
        for col = 1, 3 do
            local index = (row - 1) * 3 + col
            local item = grid[index]
            if item then
                local shortName = item:match(":(.+)") or item
                line = line .. string.format("%-15s", shortName:sub(1, 14))
            else
                line = line .. string.format("%-15s", "[empty]")
            end
        end
        print(line)
    end
    
    -- Transfer items to crafters
    print("\nTransferring items...")
    for index = 1, 9 do
        local itemId = grid[index]
        if itemId and devices.crafters[index] then
            local crafterName = devices.crafters[index].name
            print("  [" .. index .. "] " .. itemId .. " -> " .. crafterName)
            
            local success, msg = transferItem(itemId, crafterName, 1, 1)
            if not success then
                print("    ERROR: " .. msg)
                return false, msg
            end
        end
    end
    
    print("\n✓ Items placed in crafters")
    print("Waiting for craft to complete...")
    
    -- Wait for output
    sleep(5)
    
    -- Check output depot
    if devices.output_depot then
        local items = devices.output_depot.peripheral.list()
        if next(items) then
            print("✓ Crafting complete!")
            for slot, item in pairs(items) do
                print("  Output: " .. item.name .. " x" .. item.count)
            end
            return true
        else
            print("⚠ No output detected in depot_4")
            return false, "No output"
        end
    end
    
    return true
end

-- ══════════════════════════════════════════════════════════════════════════
-- UI Functions
-- ══════════════════════════════════════════════════════════════════════════

function clearScreen()
    term.clear()
    term.setCursorPos(1, 1)
end

function drawHeader()
    term.setBackgroundColor(colors.gray)
    term.setTextColor(colors.white)
    term.clearLine()
    print("  CREATE AUTOCRAFT - ADVANCED  ")
    term.setBackgroundColor(colors.black)
    print("")
end

function mainMenu()
    while true do
        clearScreen()
        drawHeader()
        print("1. Scan Devices")
        print("2. Craft Item")
        print("3. View Storage")
        print("4. Test Crafter Grid")
        print("0. Exit")
        print("")
        write("Choice: ")
        
        local choice = read()
        
        if choice == "1" then
            scanDevices()
            print("\nPress any key...")
            os.pullEvent("key")
        
        elseif choice == "2" then
            clearScreen()
            drawHeader()
            write("Enter item ID (e.g. create:brass_ingot): ")
            local itemId = read()
            
            print("\nFetching recipe...")
            local data = getRecipeData(itemId)
            
            if not data or not data.recipes or #data.recipes == 0 then
                print("No recipes found!")
                sleep(2)
            else
                print("Found " .. #data.recipes .. " recipe(s)")
                print("\nUsing first recipe...")
                
                local success, err = craftItem(itemId, data.recipes[1])
                if not success then
                    print("Craft failed: " .. (err or "unknown"))
                end
                
                print("\nPress any key...")
                os.pullEvent("key")
            end
        
        elseif choice == "3" then
            clearScreen()
            drawHeader()
            print("=== Storage Inventory ===\n")
            
            for _, storage in ipairs(devices.storage) do
                print(storage.name .. ":")
                for slot, item in pairs(storage.peripheral.list()) do
                    local name = item.name:match(":(.+)") or item.name
                    print("  [" .. slot .. "] " .. name .. " x" .. item.count)
                end
                print("")
            end
            
            print("Press any key...")
            os.pullEvent("key")
        
        elseif choice == "4" then
            clearScreen()
            drawHeader()
            print("=== Crafter Grid Test ===\n")
            
            for row = 1, 3 do
                local line = ""
                for col = 1, 3 do
                    local index = (row - 1) * 3 + col
                    if devices.crafters[index] then
                        line = line .. "[" .. index .. "] "
                    else
                        line = line .. "[ ] "
                    end
                end
                print(line)
            end
            
            print("\nPress any key...")
            os.pullEvent("key")
        
        elseif choice == "0" then
            clearScreen()
            print("Goodbye!")
            break
        end
    end
end

-- ══════════════════════════════════════════════════════════════════════════
-- Start
-- ══════════════════════════════════════════════════════════════════════════

print("Create AutoCraft - Advanced System")
print("Initializing...\n")

-- Test API connection
local stats = apiGet("/api/stats")
if not stats then
    print("ERROR: Cannot connect to API")
    print("Check that server is running at: " .. API_URL)
    return
end

print("API connected: " .. stats.totalRecipes .. " recipes available")
sleep(1)

-- Scan devices
scanDevices()
print("\nPress any key to continue...")
os.pullEvent("key")

-- Start main menu
mainMenu()
