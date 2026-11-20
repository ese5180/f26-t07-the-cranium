#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const unit='[EffectRack1_EffectUnit1]';
const slot='[EffectRack1_EffectUnit1_Effect1]';
function fixture() {
    const values=new Map([[unit+':group_[Master]_enable',1],[unit+':mix',.73],
        [unit+':focused_effect',1],[slot+':enabled',1]]);
    const writes=[],timers=new Map();let next=0;
    const engine={getValue:(g,k)=>values.get(g+':'+k)||0,
        setValue:(g,k,v)=>{values.set(g+':'+k,v);writes.push([g,k,v]);},
        setParameter:(g,k,v)=>{values.set(g+':'+k,v);writes.push([g,k,v]);},
        softTakeoverIgnoreNextValue(){},beginTimer:(ms,fn)=>{const id=++next;timers.set(id,fn);return id;},stopTimer:id=>timers.delete(id)};
    const context=vm.createContext({engine});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../controllers/Pioneer_DDJ_FLX4_RX3/Pioneer-DDJ-FLX4-script.js'),'utf8'),context);
    const m=context.PioneerDDJFLX4;
    const flush=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}};
    return {m,values,writes,flush,timers};
}
for (const order of [[1,2],[2,1]]) {
    const f=fixture();
    for (const [one,two,label] of [[127,0,'Channel1'],[0,127,'Channel2'],[127,127,'Master'],[0,127,'Channel2'],[127,0,'Channel1']]) {
        f.writes.length=0;
        for(const deck of order)f.m['beatFxChannel'+deck](0,0,deck===1?one:two,0x94,unit);
        assert.equal(f.writes.length,0,'paired switch messages must be coalesced');
        f.flush();
        for(const route of ['Master','Channel1','Channel2'])
            assert.equal(f.values.get(unit+':group_['+route+']_enable')||0,route===label?1:0);
        assert.equal(f.values.get(unit+':mix'),.73,'switch must not reset wet level');
        assert.equal(f.values.get(slot+':enabled'),1,'switch must preserve effect on/off');
        assert(f.writes.every(([g,k])=>g===unit && /^group_\[(Master|Channel1|Channel2)\]_enable$/.test(k)),
            'selector writes only its real effect input routes');
        f.writes.length=0;
        f.m.beatFxChannel1(0,0,one);f.m.beatFxChannel2(0,0,two);f.flush();
        assert.equal(f.writes.length,0,'repeat state must not spam effect routing');
    }
    f.m.shiftButtonDown=[false,false];f.m.beatFxLevelDepthRotate(0,0,64);
    assert.equal(f.values.get(unit+':mix'),64/127,'level knob still adjusts the routed unit');
    f.m.beatFxOnOffPressed(0,0,127);
    assert.equal(f.values.get(slot+':enabled'),false,'FX on/off still toggles the same effect');
    assert.equal(f.values.get(unit+':group_[Channel1]_enable'),1,'FX on/off preserves selected channel');
    f.m.beatFxChannel1(0,0,0);f.m.beatFxChannel2(0,0,0);f.writes.length=0;f.flush();
    assert.equal(f.writes.length,0,'incomplete/transitional all-off state must retain last routing');
    assert(!f.writes.some(([,k])=>['play','playposition','rate'].includes(k)));
}
const startup=fixture();startup.m.beatFxChannel1(0,0,127);startup.flush();
assert.equal(startup.writes.length,0,'wait for both flags before changing saved routing');
startup.m.beatFxChannel2(0,0,0);startup.flush();
assert.equal(startup.values.get(unit+':group_[Master]_enable'),0);
assert.equal(startup.values.get(unit+':group_[Channel1]_enable'),1);
console.log('PASS: FLX4 selector 1/2/master, both MIDI orders, startup, packet coalescing, repeat states and level control');
