-- ME Terminal Bridge v3.2 - Railway + Barrel_3/Barrel_4/Vault_4
local API_URL       = "https://me-terminal-production.up.railway.app"
local CRAFTER_NAME  = "left"
local BUFFER_NAME   = "chest_4"
local OUTPUT_NAME   = "barrel_4"
local INPUT_NAME    = "barrel_3"
local REDSTONE_SIDE = "top"
local PRESS_DEPOTS  = {"depot_5","depot_6","depot_7"}
local VAULT_NAMES   = {"item_vault_4","item_vault_5","item_vault_6","item_vault_7"}
local SYNC_INTERVAL = 2

local HEADERS = {
    ["Content-Type"]="application/json",
    ["bypass-tunnel-reminder"]="true",
    ["ngrok-skip-browser-warning"]="true"
}

local EXCLUDED = {[CRAFTER_NAME]=true,[BUFFER_NAME]=true,[OUTPUT_NAME]=true,[INPUT_NAME]=true}
for _,d in ipairs(PRESS_DEPOTS) do EXCLUDED[d]=true end

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

-- ══ Storage scan ════════════════════════════════════════════════════════
function findAllStorage()
    local devices,seen = {},{}
    for _,name in ipairs(peripheral.getNames()) do
        if not seen[name] and not EXCLUDED[name] and not name:match("^depot_") then
            local pt = peripheral.getType(name)
            if pt and (pt:find("vault") or pt:find("chest") or pt:find("barrel") or pt=="inventory") then
                local p = peripheral.wrap(name)
                if p and p.list then
                    table.insert(devices,{name=name,type=pt,p=p}); seen[name]=true
                end
            end
        end
    end
    return devices
end

function scanInventory()
    local inv,totalItems,totalStacks = {},0,0
    local devs = findAllStorage()
    for _,d in ipairs(devs) do
        local ok,items = pcall(function() return d.p.list() end)
        if ok and items then
            for slot,item in pairs(items) do
                local id = item.name
                if not inv[id] then
                    inv[id]={id=id,name=id:match(":(.+)") or id,
                             namespace=id:match("^(.+):") or "minecraft",
                             totalCount=0,locations={}}
                end
                inv[id].totalCount = inv[id].totalCount + item.count
                table.insert(inv[id].locations,{device=d.name,slot=slot,count=item.count})
                totalItems=totalItems+item.count; totalStacks=totalStacks+1
            end
        end
    end
    return inv,{totalItems=totalItems,totalStacks=totalStacks,storageDevices=#devs}
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
    local body = type(data)=="string" and data or textutils.serialiseJSON(data)
    local url = API_URL .. path
    local ok, r = pcall(http.post, url, body, HEADERS)
    if not ok or not r then
        local httpUrl = url:gsub("^https:", "http:")
        ok, r = pcall(http.post, url, body, HEADERS)
    end
    if ok and r then local b = r.readAll(); r.close(); return textutils.unserialiseJSON(b) end
    return nil
end

function pushInventory(inv,stats)
    local items={}
    for _,d in pairs(inv) do
        table.insert(items,{id=d.id,name=d.name,namespace=d.namespace,
                            count=d.totalCount,locations=#d.locations})
    end
    table.sort(items,function(a,b) return a.count>b.count end)
    httpPost("/api/inventory",{
        computerId=os.getComputerID(),timestamp=os.epoch("utc"),
        stats=stats,items=items
    })
end

function getNextJob()
    local d=httpGet("/api/queue/next")
    return d and d.job
end

function reportDone(id,ok,err)
    local ep = ok and "/api/queue/"..id.."/complete" or "/api/queue/"..id.."/fail"
    httpPost(ep, ok and {} or {error=err or "unknown"})
end

function getRecipe(itemId)
    local d=httpGet("/api/recipes/"..itemId:gsub(":","__"))
    if d and d.recipes and #d.recipes>0 then return d.recipes[1] end
    return nil
end

-- ══ Recipe parsing ═══════════════════════════════════════════════════════
local function extractIng(ing)
    if type(ing)=="string" then return ing end
    if type(ing)~="table" then return nil end
    if ing.item then return ing.item end
    if ing.tag  then return "#"..ing.tag end
    if ing[1]   then return extractIng(ing[1]) end
    return nil
end

function parseGrid(recipe)
    local t=recipe.type; local data=recipe.data or {}
    if t=="minecraft:crafting_shaped" or t=="create:mechanical_crafting" then
        local pat=data.pattern or {}; local key=data.key or {}; local grid={}
        for row=1,3 do for col=1,3 do
            local idx=(row-1)*3+col
            local ch=pat[row] and pat[row]:sub(col,col) or " "
            if ch~=" " and key[ch] then grid[idx]=extractIng(key[ch]) end
        end end
        return grid,"crafter"
    elseif recipe.custom then
        local raw=recipe.grid or {}; local grid={}
        for i=1,9 do local v=raw[i]; grid[i]=(v~=nil and v~="") and v or nil end
        return grid,"crafter"
    elseif t=="create:pressing" or t=="create:cutting" or t=="create:milling"
        or t=="create:crushing" or t=="create:sandpaper_polishing" then
        local ings=data.ingredients or {}; local grid={}
        grid[5]=extractIng(ings[1] or ings)
        return grid,"press"
    end
    return nil,"unknown"
end

-- ══ Item search ════════════════════════════════════════════════════════════
function findItem(itemId)
    local isTag=itemId:sub(1,1)=="#"; local tag=isTag and itemId:sub(2) or nil
    local best=nil
    for _,dev in ipairs(findAllStorage()) do
        local ok,items=pcall(function() return dev.p.list() end)
        if ok and items then
            for slot,item in pairs(items) do
                if not isTag then
                    if item.name==itemId then return dev.name,slot,item.count end
                else
                    local sim=tag:gsub("^c:",""):gsub("^forge:","")
                    local base=sim:match("([^/]+)$") or sim
                    local pats={base}
                    if sim:match("^ingots/") then pats={base.."_ingot"}
                    elseif sim:match("^plates/") or sim:match("^sheets/") then pats={base.."_plate",base.."_sheet"}
                    elseif sim:match("^nuggets/") then pats={base.."_nugget"}
                    elseif sim:match("^dusts/") then pats={base.."_dust"}
                    elseif sim:match("^gears/") then pats={base.."_gear"}
                    elseif sim:match("^rods/") then pats={base.."_rod"} end
                    local ibase=item.name:match(":(.+)") or item.name
                    for _,pat in ipairs(pats) do
                        if ibase==pat or ibase:match(pat.."$") then
                            local prio=item.name:match("^minecraft:") and 1
                                    or item.name:match("^create:") and 2 or 10
                            if not best or prio<best.prio then
                                best={storage=dev.name,slot=slot,count=item.count,prio=prio}
                            end
                            break
                        end
                    end
                end
            end
        end
    end
    if best then return best.storage,best.slot,best.count end
    return nil
end

-- ══ Transfer helpers ══════════════════════════════════════════════════════
function moveViaBuffer(srcName,srcSlot,qty,targetName,targetSlot)
    local buf=peripheral.wrap(BUFFER_NAME)
    if not buf then return false,"no buffer" end
    local short=srcName:match("item_vault_%d+") or srcName:match("chest_%d+")
             or srcName:match("([^:]+)$") or srcName
    local ok,n=pcall(function() return buf.pullItems(short,srcSlot,qty) end)
    if not ok or not n or n==0 then
        ok,n=pcall(function() return buf.pullItems(srcName,srcSlot,qty) end)
    end
    if not ok or not n or n==0 then return false,"vault->buf failed" end
    sleep(0.05)
    local bs=nil; for s in pairs(buf.list()) do bs=s; break end
    if not bs then return false,"item lost in buffer" end
    local ok2,n2
    if targetSlot then ok2,n2=pcall(function() return buf.pushItems(targetName,bs,n,targetSlot) end)
    else ok2,n2=pcall(function() return buf.pushItems(targetName,bs,n) end) end
    if not ok2 or not n2 or n2==0 then return false,"buf->target failed" end
    return true,n2
end

function flushToVault(periphName)
    local p=peripheral.wrap(periphName)
    if not p or not p.list then return end
    local buf=peripheral.wrap(BUFFER_NAME); if not buf then return end
    local pShort=periphName:match("depot_%d+") or periphName:match("barrel_%d+")
               or periphName:match("([^:]+)$") or periphName
    for slot,item in pairs(p.list()) do
        local ok,n=pcall(function() return buf.pullItems(pShort,slot,item.count) end)
        if ok and n and n>0 then
            sleep(0.05)
            for bs in pairs(buf.list()) do
                for _,vn in ipairs(VAULT_NAMES) do
                    local vault=peripheral.wrap(vn)
                    if vault then pcall(function() vault.pullItems(BUFFER_NAME,bs,n) end) end
                end
                break
            end
        end
        sleep(0.05)
    end
end

function clearCrafter()
    local cr=peripheral.wrap(CRAFTER_NAME); if not cr then return end
    for slot in pairs(cr.list()) do
        pcall(function() cr.pushItems(BUFFER_NAME,slot,64) end); sleep(0.05)
        local buf=peripheral.wrap(BUFFER_NAME)
        if buf then
            for bs in pairs(buf.list()) do
                for _,vn in ipairs(VAULT_NAMES) do
                    local v=peripheral.wrap(vn)
                    if v then pcall(function() v.pullItems(BUFFER_NAME,bs,64) end) end
                end
                break
            end
        end
    end
end

-- ══ Craft execution ═══════════════════════════════════════════════════════
function runCrafterRecipe(job,grid)
    local crafter=peripheral.wrap(CRAFTER_NAME)
    if not crafter then
        local msg="crafter '"..CRAFTER_NAME.."' not found! Peripherals: "
                  ..table.concat(peripheral.getNames(),", ")
        log(msg,"error"); flushLog(); return false,msg
    end
    local output=peripheral.wrap(OUTPUT_NAME)
    if not output then
        log("[FAIL] barrel '"..OUTPUT_NAME.."' not found!","error")
        local all={}; for _,n in ipairs(peripheral.getNames()) do
            table.insert(all,n.."("..peripheral.getType(n)..")") end
        log("Peripherals: "..table.concat(all,", "),"warn"); flushLog()
        return false,"barrel not found"
    end

    local totalCrafted=0
    log("Crafter="..CRAFTER_NAME.." Output="..OUTPUT_NAME)

    for pass=1,job.amount do
        log("Pass "..pass.."/"..job.amount,"yellow")
        clearCrafter()

        -- Fill slots
        for slotIdx=1,9 do
            if grid[slotIdx] then
                local itemId=grid[slotIdx]
                local src,srcSlot=findItem(itemId)
                if not src then
                    log("[FAIL] missing: "..itemId,"error"); flushLog()
                    clearCrafter(); return false,"missing: "..itemId
                end
                log("  slot "..slotIdx.." <- "..(itemId:match(":(.+)") or itemId).." from "..src)
                local ok,n=moveViaBuffer(src,srcSlot,1,CRAFTER_NAME,slotIdx)
                if not ok then
                    log("[FAIL] slot "..slotIdx.." transfer: "..(n or "?"),"error"); flushLog()
                    clearCrafter(); return false,"transfer failed slot "..slotIdx
                end
                sleep(0.15)
            end
        end

        -- Verify
        local cnt=0; for _ in pairs(crafter.list()) do cnt=cnt+1 end
        log("Crafter filled: "..cnt.." slots")
        if cnt==0 then
            log("[FAIL] crafter empty after fill!","error"); flushLog()
            return false,"crafter empty after fill"
        end

        -- Redstone pulse
        log("RS pulse -> "..REDSTONE_SIDE)
        local rsOk,rsErr=pcall(function() redstone.setOutput(REDSTONE_SIDE,true) end)
        if not rsOk then log("[WARN] RS error: "..tostring(rsErr),"warn") end
        sleep(0.5)
        pcall(function() redstone.setOutput(REDSTONE_SIDE,false) end)

        -- Wait up to 6s for output
        local got=false; local crafterCleared=false
        log("Waiting output in "..OUTPUT_NAME.."...")
        for t=1,12 do
            sleep(0.5)
            -- Check barrel
            local ok2,outItems=pcall(function() return output.list() end)
            if ok2 and outItems then
                for _,itm in pairs(outItems) do
                    if itm.name==job.itemId then
                        totalCrafted=totalCrafted+itm.count
                        log("GOT "..itm.count.."x "..itm.name,"ok"); got=true; break
                    end
                end
            end
            if got then break end
            -- Check if crafter cleared
            local ok3,cItems=pcall(function() return crafter.list() end)
            if ok3 and cItems then
                local full=false; for _ in pairs(cItems) do full=true; break end
                if not full and not crafterCleared then
                    crafterCleared=true
                    log("Crafter fired at "..tostring(t*0.5).."s, waiting hopper...")
                end
            end
            if crafterCleared and t>=4 then
                local ok4,out2=pcall(function() return output.list() end)
                if ok4 and out2 then
                    for _,itm in pairs(out2) do
                        totalCrafted=totalCrafted+itm.count
                        log("GOT "..itm.count.."x "..itm.name.." (hopper)","ok"); got=true; break
                    end
                end
                if got then break end
            end
        end

        if not got then
            log("[WARN] no output after 6s","warn")
            local ok5,out3=pcall(function() return output.list() end)
            if ok5 and out3 then
                local contents={}
                for _,itm in pairs(out3) do table.insert(contents,itm.name.."x"..itm.count) end
                log("Barrel has: "..(#contents>0 and table.concat(contents,", ") or "EMPTY"),"warn")
            end
            if crafterCleared then
                log("Crafter fired, output may be elsewhere - continuing","warn"); got=true end
        end

        flushLog()
        flushToVault(OUTPUT_NAME); sleep(0.1)
    end

    log("Done: "..totalCrafted.."x "..job.itemId,"ok"); flushLog()
    return true
end

function runPressRecipe(job,grid)
    local itemId=grid[5]
    if not itemId then return false,"no ingredient in press recipe" end
    local depotName=nil
    for _,dn in ipairs(PRESS_DEPOTS) do
        local p=peripheral.wrap(dn)
        if p and p.list then
            local empty=true; for _ in pairs(p.list()) do empty=false; break end
            if empty then depotName=dn; break end
        end
    end
    if not depotName then return false,"no free press depot" end
    log("Press depot: "..depotName)
    for pass=1,job.amount do
        log("Pass "..pass.."/"..job.amount,"yellow")
        local src,srcSlot=findItem(itemId)
        if not src then flushLog(); return false,"missing: "..itemId end
        local ok,n=moveViaBuffer(src,srcSlot,1,depotName)
        if not ok then flushLog(); return false,"transfer failed: "..(n or "?") end
        local depot=peripheral.wrap(depotName); local done=false
        for t=1,20 do
            sleep(0.5)
            if depot and depot.list then
                for _,itm in pairs(depot.list()) do
                    if itm.name==job.itemId then
                        log("GOT "..itm.count.."x "..itm.name,"ok"); done=true; break end
                end
            end
            if done then break end
        end
        if not done then log("[WARN] no press output after 10s","warn") end
        flushToVault(depotName); sleep(0.1)
    end
    flushLog(); return true
end

function executeJob(job)
    log("=== JOB #"..job.id.." "..job.amount.."x "..job.itemId.." ===","cyan")
    local recipe=getRecipe(job.itemId)
    if not recipe then
        local msg="no recipe for "..job.itemId
        log(msg,"error"); flushLog(); return false,msg
    end
    log("Recipe: "..recipe.type)
    local grid,mode=parseGrid(recipe)
    if not grid or mode=="unknown" then
        local msg="unsupported recipe type: "..recipe.type
        log(msg,"error"); flushLog(); return false,msg
    end
    -- Result count per craft
    local resultCount=1
    if recipe.data then
        local r=recipe.data.result
        if type(r)=="table" and r.count then resultCount=r.count
        elseif recipe.data.results and recipe.data.results[1] then
            local r2=recipe.data.results[1]
            if type(r2)=="table" and r2.count then resultCount=r2.count end
        end
    end
    if recipe.resultCount then resultCount=recipe.resultCount end
    local passes=math.ceil(job.amount/resultCount)
    log("Result/craft: "..resultCount.." | Passes needed: "..passes)
    -- Show grid
    for row=1,3 do
        local line=""
        for col=1,3 do
            local v=grid[(row-1)*3+col]
            line=line.."["..(v and (v:match(":(.+)") or v):sub(1,7) or "  ---  ").."]"
        end
        log(line)
    end
    local jobP={id=job.id,itemId=job.itemId,amount=passes}
    if mode=="crafter" then return runCrafterRecipe(jobP,grid)
    else return runPressRecipe(jobP,grid) end
end

-- ══ Display ════════════════════════════════════════════════════════════════
local lastStats={totalItems=0,totalStacks=0,storageDevices=0}
local lastOnline=false; local craftCount=0

function redraw()
    term.setBackgroundColor(colors.black); term.clear(); term.setCursorPos(1,1)
    term.setBackgroundColor(colors.gray); term.setTextColor(colors.white)
    term.clearLine(); term.write("  ME TERMINAL v3.1 — LIVE LOG ON WEBSITE  ")
    term.setBackgroundColor(colors.black)
    term.setCursorPos(1,3); term.setTextColor(colors.yellow)
    print("Storage : "..lastStats.storageDevices.." devices")
    term.setTextColor(colors.cyan)
    print("Items   : "..lastStats.totalItems.." | Stacks: "..lastStats.totalStacks)
    term.setCursorPos(1,6)
    if lastOnline then term.setTextColor(colors.lime); print("API     : ONLINE")
    else term.setTextColor(colors.red); print("API     : OFFLINE") end
    term.setTextColor(colors.white); term.setCursorPos(1,8)
    print("Crafted : "..craftCount.." jobs done")
    term.setCursorPos(1,10); term.setTextColor(colors.lightBlue)
    print(API_URL.."/crafts.html  (CC Log tab)")
    term.setCursorPos(1,12); term.setTextColor(colors.white)
    print("R=rescan  Ctrl+T=stop")
end

-- ══ Event loop ═════════════════════════════════════════════════════════════
local timerOwner={}

function taskInventorySync()
    local inv,stats=scanInventory()
    lastOnline=pcall(function() pushInventory(inv,stats) end)
    lastStats=stats; redraw()
    while true do
        local tid=os.startTimer(SYNC_INTERVAL); timerOwner[tid]="sync"
        while true do
            local _,id=os.pullEvent("timer")
            if timerOwner[id]=="sync" then timerOwner[id]=nil; break end
        end
        local inv2,stats2=scanInventory(); lastStats=stats2
        lastOnline=pcall(function() pushInventory(inv2,stats2) end)
        redraw()
    end
end

function taskCraftQueue()
    sleep(1)
    while true do
        local tid=os.startTimer(3); timerOwner[tid]="craft"
        while true do
            local _,id=os.pullEvent("timer")
            if timerOwner[id]=="craft" then timerOwner[id]=nil; break end
        end
        local job=getNextJob()
        if job then
            log("NEW JOB #"..job.id.." "..job.amount.."x "..job.itemId,"cyan")
            local ok,err=executeJob(job)
            if ok then
                craftCount=craftCount+1; reportDone(job.id,true)
                log("JOB #"..job.id.." COMPLETED","ok")
            else
                reportDone(job.id,false,err)
                log("JOB #"..job.id.." FAILED: "..(err or "?"),"error")
            end
            flushLog(); redraw()
        end
    end
end

function taskInput()
    while true do
        local _,key=os.pullEvent("key")
        if key==keys.r then
            local inv,stats=scanInventory(); lastStats=stats
            pcall(function() pushInventory(inv,stats) end); redraw()
        end
    end
end

-- ══ Startup ════════════════════════════════════════════════════════════════
term.setBackgroundColor(colors.black); term.clear()
term.setCursorPos(1,1); term.setTextColor(colors.yellow)
print("ME Terminal v3.1 starting...")
print("Logs appear at: "..API_URL.."/crafts.html")
print("Testing connection...")

local ok=pcall(function()
    local r=http.get(API_URL.."/api/stats",HEADERS)
    if r then r.close() else error("no response") end
end)
if not ok then
    term.setTextColor(colors.red)
    print("ERROR: Cannot connect to API!"); return
end
term.setTextColor(colors.lime); print("Connected!")
sleep(1)
parallel.waitForAny(taskInventorySync,taskCraftQueue,taskInput)
