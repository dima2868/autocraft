-- ══════════════════════════════════════════════════════════════════════════
-- TEST TRANSFER - Test moving 4 iron from vault to chest
-- ══════════════════════════════════════════════════════════════════════════

print("╔════════════════════════════════════════╗")
print("║  TRANSFER TEST")
print("║  Moving 4x minecraft:iron_ingot")
print("║  From: create:item_vault_6")
print("║  To: minecraft:chest_4")
print("╚════════════════════════════════════════╝\n")

-- Find vault and chest
local vaultName = "create:item_vault_7в"
local chestName = "minecraft:chest_4"

print("Step 1: Wrapping peripherals...")
local vault = peripheral.wrap(vaultName)
local chest = peripheral.wrap(chestName)

if not vault then
    print("✗ Cannot find vault: " .. vaultName)
    return
end

if not chest then
    print("✗ Cannot find chest: " .. chestName)
    return
end

print("✓ Both peripherals found\n")

-- Find iron in vault
print("Step 2: Finding iron_ingot in vault...")
local ironSlot = nil
local ironCount = 0

for slot, item in pairs(vault.list()) do
    if item.name == "minecraft:iron_ingot" then
        ironSlot = slot
        ironCount = item.count
        print("✓ Found in slot " .. slot .. ": " .. ironCount .. "x")
        break
    end
end

if not ironSlot then
    print("✗ No iron_ingot found in vault!")
    return
end

print("")

-- Try all possible methods
local methods = {
    {name = "vault.pushItems('chest_4', slot, 4)", func = function()
        return vault.pushItems("chest_4", ironSlot, 4)
    end},
    {name = "vault.pushItems('minecraft:chest_4', slot, 4)", func = function()
        return vault.pushItems("minecraft:chest_4", ironSlot, 4)
    end},
    {name = "chest.pullItems('item_vault_6', slot, 4)", func = function()
        return chest.pullItems("item_vault_6", ironSlot, 4)
    end},
    {name = "chest.pullItems('create:item_vault_6', slot, 4)", func = function()
        return chest.pullItems("create:item_vault_6", ironSlot, 4)
    end},
}

print("Step 3: Testing transfer methods...\n")

for i, method in ipairs(methods) do
    print("[Method " .. i .. "] " .. method.name)
    
    local success, result = pcall(method.func)
    
    if success then
        print("  Result: " .. tostring(result))
        if type(result) == "number" and result > 0 then
            print("  ✓✓✓ SUCCESS! Moved " .. result .. " items")
            print("\n╔════════════════════════════════════════╗")
            print("║  ✓ WORKING METHOD FOUND!")
            print("║  Use: " .. method.name)
            print("╚════════════════════════════════════════╝")
            return
        else
            print("  ✗ Returned 0 or invalid")
        end
    else
        print("  ✗ Exception: " .. tostring(result))
    end
    print("")
end

print("╔════════════════════════════════════════╗")
print("║  ✗ ALL METHODS FAILED")
print("║  This means vault and chest cannot")
print("║  communicate via wired modem network")
print("╚════════════════════════════════════════╝")

print("\nTroubleshooting:")
print("1. Check wired modem cables connect vault <-> chest")
print("2. Right-click modems to ensure they're red (active)")
print("3. Make sure cables form continuous path")
print("4. Try: 'peripherals' command to see all connected")
