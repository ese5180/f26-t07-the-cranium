#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const unit='[EffectRack1_EffectUnit1]',slot='[EffectRack1_EffectUnit1_Effect1]';
function fixture(native,focus) {
    const values=new Map([['[RX3Browser]:enabled',native?1:0],[unit+':focused_effect',focus]]),writes=[],midi=[];
    const engine={getValue:(g,k)=>values.get(g+':'+k)||0,
        setValue:(g,k,v)=>{values.set(g+':'+k,v);writes.push([g,k,v]);},
        setParameter:(g,k,v)=>{values.set(g+':'+k,v);writes.push([g,k,v]);},softTakeoverIgnoreNextValue(){}};
    const c=vm.createContext({engine,midi:{sendShortMsg:(...args)=>midi.push(args)}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../controllers/Pioneer_DDJ_FLX4_RX3/Pioneer-DDJ-FLX4-script.js'),'utf8'),c);
    return {m:c.PioneerDDJFLX4,values,writes,midi};
}
for(const focus of [0,1,2,3]) {
    const {m,values,writes,midi}=fixture(true,focus);
    assert.equal(m.focusedFxGroup(),slot,'native UI always uses the displayed effect, never hidden slots');
    for(let i=0;i<4;i++){m.beatFxSelectPressed(0,0,127);m.beatFxSelectPressed(0,0,0);}
    assert.deepEqual(writes,Array.from({length:4},()=>[['[RX3BeatFx]','select_next',1],['[RX3BeatFx]','select_next',0]]).flat());
    writes.length=0;m.beatFxSelectShiftPressed(0,0,127);m.beatFxSelectShiftPressed(0,0,0);
    assert.deepEqual(writes,[['[RX3BeatFx]','select_previous',1],['[RX3BeatFx]','select_previous',0]]);
    writes.length=0;m.beatFxOnOffPressed(0,0,127);m.beatFxOnOffPressed(0,0,0);
    assert.deepEqual(writes,[['[RX3BeatFx]','toggle',1],['[RX3BeatFx]','toggle',0]]);
    writes.length=0;m.beatFxLeftPressed(0,0,127);m.beatFxRightPressed(0,0,127);
    assert.deepEqual(writes,[['[RX3BeatFx]','step',-1],['[RX3BeatFx]','step',0],['[RX3BeatFx]','step',1],['[RX3BeatFx]','step',0]]);
    values.set(slot+':enabled',1);values.set(unit+':enabled',0);m.toggleFxLight();
    assert(midi.slice(-2).every(x=>x[2]===0),'LED off when effect chain is disabled');
    values.set(unit+':enabled',1);m.toggleFxLight();assert(midi.slice(-2).every(x=>x[2]===127));
    m.shiftButtonDown=[true,false];writes.length=0;m.beatFxLevelDepthRotate(0,0,64);
    assert(writes.some(([g,k])=>g===slot && k==='meta'),'shift level/depth still targets displayed slot');
}
const stock=fixture(false,3);stock.m.beatFxSelectPressed(0,0,127);stock.m.beatFxSelectPressed(0,0,127);
assert.deepEqual(stock.writes,[[unit.slice(0,-1)+'_Effect3]','next_effect',1],[unit.slice(0,-1)+'_Effect3]','next_effect',0],
    [unit.slice(0,-1)+'_Effect3]','next_effect',1],[unit.slice(0,-1)+'_Effect3]','next_effect',0]]);
console.log('PASS: repeated SELECT, shift reverse, visible slot, real enable/LED controls, timing buttons and stock fallback');
