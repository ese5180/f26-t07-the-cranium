#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
    '../controllers/Hercules_DJControl_Inpulse_500_RX3/Hercules-DJControl-Inpulse-500-RX3-script.js'), 'utf8');

function fixture(native = true) {
    let now = 1000, nextTimer = 1;
    const values = new Map([['[Tab]:current', 1], ['[RX3Browser]:enabled', native ? 1 : 0],
        ['[Skin]:show_maximized_library', 1], ['[Channel1]:play', 1],
        ['[RX3SidePanel]:current', 0]]);
    const writes = [], timers = new Map();
    const engine = {
        getValue(g, k) { return values.get(`${g}:${k}`) || 0; },
        setValue(g, k, v) {
            values.set(`${g}:${k}`, v); writes.push([g, k, v]);
            if (g === '[Tab]' && v === 1 && ['overview', 'library'].includes(k)) {
                values.set('[Tab]:current', k === 'library' ? 1 : 0);
            }
        },
        beginTimer(ms, callback) { const id = nextTimer++; timers.set(id, {at: now + ms, callback}); return id; },
        stopTimer(id) { timers.delete(id); },
        isScratching() { return false; },
    };
    const context = vm.createContext({engine, Date: {now: () => now}, components: {Deck: function() {}}, script: {deckFromGroup: g => Number(g.match(/\d+/)[0]),triggerControl: (g,k) => engine.setValue(g,k,1)},
        midi: {sendShortMsg() {}}, console});
    vm.runInContext(fs.readFileSync(path.join(__dirname,"../controllers/Hercules_DJControl_Inpulse_500_RX3/Nautic-RX3-Encoder-Hercules.js"),"utf8"),context);
    vm.runInContext(source, context);
    const m = context.DJCi500;
    m.deckA = {isShiftPressed: false,currentDeck:"[Channel1]"}; m.deckB = {isShiftPressed: false,currentDeck:"[Channel2]"};
    return {m, values, writes, timers, engine,
        press: () => m.rx3AssistantButton(0, 3, 127, 0x90),
        release: (value = 0, status = 0x90) => m.rx3AssistantButton(0, 3, value, status),
        advance(ms, fire = true) {
            now += ms;
            if (fire) for (const [id, timer] of [...timers]) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
        }};
}

function browserPress(f) { f.m.rx3BrowserPush(0, 0, 127, 0x90); }
function browserRelease(f) { f.m.rx3BrowserPush(0, 0, 0, 0x80); }
const before = fixture(); before.values.set('[Tab]:current', 0);
browserPress(before); before.advance(1999);
assert.equal(before.engine.getValue('[RX3Controller]', 'grid_mode'), 0);
browserRelease(before);
assert.equal(before.engine.getValue('[RX3Controller]', 'grid_mode'), 0);
const exact = fixture(); exact.values.set('[Tab]:current', 0);
exact.values.set('[RX3Controller]:active_deck', 2);
exact.values.set('[Channel2]:track_loaded', 1);
browserPress(exact); exact.advance(2000);
assert.equal(exact.engine.getValue('[RX3Controller]', 'grid_mode'), 1);
browserRelease(exact);
assert.equal(exact.engine.getValue('[RX3Controller]', 'grid_mode'), 1, 'release must not exit GRID');
exact.writes.length = 0;
exact.m.moveLibrary(0, 0, 1, 0xB0);
assert(exact.writes.some(([g,k,v]) => g === '[Channel2]' && k === 'beats_translate_move' && v === 1));
assert(!exact.writes.some(([g]) => g === '[Channel1]'));
exact.m.moveLibrary(0, 0, 127, 0xB0);
assert(exact.writes.some(([g,k,v]) => g === '[Channel2]' && k === 'beats_translate_move' && v === -1));
exact.m.rx3BrowserIgnoreUntil = 0;
browserPress(exact); browserRelease(exact);
assert.equal(exact.engine.getValue('[RX3Controller]', 'grid_mode'), 0);
const browse = fixture(); browserPress(browse); browse.advance(2000);
assert.equal(browse.engine.getValue('[RX3Controller]', 'grid_mode'), 0, 'BROWSE hold never enters GRID');
const moved = fixture(); moved.values.set('[Tab]:current', 0);
browserPress(moved); moved.m.moveLibrary(0,0,1,0xB0); moved.advance(2000);
assert.equal(moved.engine.getValue('[RX3Controller]', 'grid_mode'), 0);
assert(browse.writes.some(([g,k,v]) => g==='[RX3Browser]' && k==='back' && v===1), 'BROWSE hold executes BACK');
const shifted = fixture(); shifted.values.set('[Tab]:current',0);
shifted.m.rx3BrowserBack(0,0,127,0x93);shifted.advance(1999);
assert(!shifted.writes.some(([g,k]) => g==='[RX3Shortcut]' && k==='toggle'));
shifted.advance(1);shifted.m.rx3BrowserBack(0,0,64,0x83);
assert.equal(shifted.writes.filter(([g,k,v]) => g==='[RX3Shortcut]' && k==='toggle' && v===1).length,1);
assert.equal(shifted.engine.getValue('[RX3Controller]','grid_mode'),0);
const panel = fixture();panel.values.set('[RX3Shortcut]:visible',1);
browserPress(panel);browserRelease(panel);panel.m.moveLibrary(0,0,1,0xB0);
assert(panel.writes.some(([g,k,v]) => g==='[RX3Shortcut]' && k==='enter' && v===1));
assert(panel.writes.some(([g,k,v]) => g==='[RX3Shortcut]' && k==='move' && v===1));
assert(!panel.writes.some(([g,k]) => g==='[RX3Browser]' && k==='enter'));
const load = fixture();load.values.set('[Tab]:current',0);load.writes.length=0;
load.m.rx3LoadTrack(0,0,127,0x92,'[Channel2]');
assert.equal(load.engine.getValue('[RX3Controller]','active_deck'),2);
assert(!load.writes.some(([g,k]) => k==='LoadSelectedTrack'));
load.values.set('[Tab]:current',1);load.m.rx3LoadTrack(0,0,127,0x92,'[Channel2]');
assert(load.writes.some(([g,k,v]) => g==='[Channel2]' && k==='LoadSelectedTrack' && v===1));
console.log('PASS: GRID exact two-second hold, release, selected-deck encoder routing, direction and cancellation');
