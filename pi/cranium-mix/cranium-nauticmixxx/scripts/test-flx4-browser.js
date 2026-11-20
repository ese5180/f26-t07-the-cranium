#!/usr/bin/env node
// Verify browser-only FLX4 callbacks without requiring physical hardware.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../controllers/Pioneer_DDJ_FLX4_RX3/Pioneer-DDJ-FLX4-RX3-Browser.js'), 'utf8');

function mapping(native) {
    const values = new Map([
        ['[RX3Browser]:enabled', native ? 1 : 0],
        ['[Tab]:current', 0],
        ['[Skin]:show_maximized_library', 0],
        ['[Channel1]:waveform_zoom', 3], ['[Channel2]:waveform_zoom', 3],
    ]);
    const writes = [];
    const engine = {
        beginTimer() {return 1;}, stopTimer() {},
        getValue(group, key) { return values.get(`${group}:${key}`) || 0; },
        setValue(group, key, value) {
            writes.push([group, key, value]);
            values.set(`${group}:${key}`, value);
            // A stock Mixxx skin has no NauticMixxx tab stack: its library
            // maximization control changes, but [Tab],current stays at zero.
            if (native && group === '[Tab]' && key === 'library' && value === 1) values.set('[Tab]:current', 1);
            if (native && group === '[Tab]' && key === 'overview' && value === 1) values.set('[Tab]:current', 0);
        },
    };
    const context = vm.createContext({engine});
    vm.runInContext(fs.readFileSync(path.join(__dirname,"../controllers/Pioneer_DDJ_FLX4_RX3/Nautic-RX3-Encoder-FLX4.js"),"utf8"),context);
    vm.runInContext(source, context);
    return {m: context.NauticFLX4Browser, values, writes};
}

for (const native of [false, true]) {
    const {m, values, writes} = mapping(native);
    m.turn(0, 0, 1);
    assert.equal(values.get('[Channel1]:waveform_zoom'), native ? 2 : 3,
        'clockwise performance turn zooms in exactly one step on the native skin');
    assert.equal(values.get('[Channel2]:waveform_zoom'), native ? 2 : 3);
    assert.equal(writes.some(([g])=>g==='[Tab]' || g==='[Library]' || g==='[RX3Browser]'),false,
        'performance turn must not browse or leave performance');
    m.enter(0, 0, 127);m.enter(0, 0, 0);
    assert.equal(values.get('[Skin]:show_maximized_library'), 1, 'encoder opens browser');
    assert.equal(values.get('[Tab]:current'), native ? 1 : 0,
        'stock Mixxx does not provide the NauticMixxx tab state');
    assert.equal(writes.some(([g, k]) => k === 'GoToItem' || k === 'enter'), false,
        'first press must not also select an item');
    m.turn(0, 0, 1);
    m.turn(0, 0, 127);
    const moveGroup = native ? '[RX3Browser]' : '[Library]';
    assert.equal(writes.some(([g, k, v]) => g === moveGroup &&
        (native ? k === 'move' && v === 1 : k === 'MoveDown' && v === 1)), true);
    assert.equal(writes.some(([g, k, v]) => g === moveGroup &&
        (native ? k === 'move' && v === -1 : k === 'MoveUp' && v === 1)), true);
    m.enter(0, 0, 127);m.enter(0, 0, 0);
    assert.equal(writes.some(([g, k, v]) => g === moveGroup &&
        k === (native ? 'enter' : 'GoToItem') && v === 1), true);
    m.back(0, 0, 127);
    assert.equal(writes.some(([g, k, v]) => g === moveGroup &&
        k === (native ? 'back' : 'MoveLeft') && v === 1), true);
    m.source(0, 0, 127);
    assert.equal(writes.some(([g, k, v]) => g === (native ? '[RX3Browser]' : '[Library]') &&
        k === (native ? 'source' : 'focused_widget') && v === (native ? 1 : 2)), true);
    m.view(0, 0, 0);
    assert.equal(values.get('[Skin]:show_maximized_library'), 1,
        'releasing VIEW must not close the browser');
    m.view(0, 0, 127);
    assert.equal(values.get('[Skin]:show_maximized_library'), 0,
        'VIEW returns to performance without loading a track');
    assert.equal(values.get('[Tab]:current'), 0, 'native tab returns to performance');
    m.view(0, 0, 0);
    assert.equal(values.get('[Skin]:show_maximized_library'), 0,
        'releasing VIEW must not reopen the browser');
    m.view(0, 0, 127);
    assert.equal(values.get('[Skin]:show_maximized_library'), 1, 'VIEW reopens browser');
}
{
    const {m,values,writes}=mapping(true);
    function turn(v) {m.turn(0,0,v);}
    turn(127);
    assert.equal(values.get('[Channel1]:waveform_zoom'),4,'counterclockwise zooms out one level');
    turn(0);assert.equal(values.get('[Channel1]:waveform_zoom'),4,'zero CC is ignored');
    values.set('[Channel1]:waveform_zoom',10);values.set('[Channel2]:waveform_zoom',10);
    writes.length=0;turn(127);assert.equal(writes.length,0,'upper limit does not spam writes');
    turn(1);assert.equal(values.get('[Channel1]:waveform_zoom'),9,'far-out notch is still exactly one step');
    for(let i=0;i<20;i++)turn(1);
    assert.equal(values.get('[Channel1]:waveform_zoom'),1);assert.equal(values.get('[Channel2]:waveform_zoom'),1);
    values.set('[RX3Info]:visible',1);writes.length=0;turn(1);
    assert(writes.some(([g,k,v])=>g==='[RX3Info]' && k==='move' && v===1));
    assert(!writes.some(([,k])=>k==='waveform_zoom'));
    values.set('[RX3Info]:visible',0);values.set('[RX3Shortcut]:visible',1);writes.length=0;turn(127);
    assert(writes.some(([g,k,v])=>g==='[RX3Shortcut]' && k==='move' && v===-1));
    assert(!writes.some(([,k])=>k==='waveform_zoom'));
    values.set('[RX3Shortcut]:visible',0);values.set('[RX3Controller]:grid_mode',1);writes.length=0;turn(1);
    assert(writes.some(([,k,v])=>k==='beats_translate_move' && v===1));
    assert(!writes.some(([,k])=>k==='waveform_zoom'));
    assert(!writes.some(([,k])=>['play','playposition','rate','pitch_adjust'].includes(k)));
}
process.stdout.write('DDJ-FLX4 browser mapping: 2 modes passed\n');
