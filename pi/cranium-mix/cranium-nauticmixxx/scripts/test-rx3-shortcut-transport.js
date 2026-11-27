#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const helpers={Hercules_DJControl_Inpulse_500_RX3:'Hercules',Pioneer_DDJ_FLX4_RX3:'FLX4',Pioneer_DDJ_FLX6_RX3:'FLX6',Pioneer_Roland_RX3:'Pioneer-Roland'};
for(const [folder,suffix] of Object.entries(helpers)) {
    const values=new Map(),brakes=[];
    const engine={getValue:(g,k)=>values.get(g+':'+k)||0,
        setValue:(g,k,v)=>values.set(g+':'+k,v),brake:(...args)=>brakes.push(args)};
    const context=vm.createContext({engine});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../controllers',folder,`Nautic-RX3-Encoder-${suffix}.js`),'utf8'),context);
    const h=context.NauticRX3Encoder;
    values.set('[Channel2]:play',1);values.set('[RX3Settings]:vinyl_speed2',1);values.set('[RX3Settings]:vinyl_stop2',5);
    assert.equal(h.brakePress(127,0x91,'[Channel2]'),true);
    assert.deepEqual(brakes[0],[2,true,0.5]);
    assert.equal(h.brakePress(64,0x81,'[Channel2]'),true,'consume nonzero Note Off after brake');
    assert.equal(h.brakePress(0,0x91,'[Channel2]'),false);
    values.set('[RX3Settings]:vinyl_speed2',0);
    assert.equal(h.brakePress(127,0x91,'[Channel2]'),false);
    values.set('[Channel2]:play',0);values.set('[RX3Settings]:vinyl_speed2',1);
    assert.equal(h.brakePress(127,0x91,'[Channel2]'),false,'starting a stopped track stays normal');
    assert.equal(h.brakePress(127,0x92,'[Channel3]'),false);
    const writes=[];let now=0;
    engine.setValue=(g,k,v)=>{values.set(g+':'+k,v);writes.push([g,k,v]);};
    engine.beginTimer=()=>1;engine.stopTimer=()=>{};
    context.Date={now:()=>now};
    const backend={isOpen:()=>false,shortPress:()=>assert.fail('INFO must consume Browse press'),originalTurn:()=>assert.fail('INFO must consume Browse turn')};
    values.set('[RX3Info]:visible',1);
    h.press(backend,127,0x90,false);assert.equal(values.get('[RX3Info]:hold'),1);
    now=3000;h.longPress();assert.equal(values.get('[RX3Info]:visible'),1);
    assert(!writes.some(([g,k])=>g==='[RX3Controller]' && k==='grid_mode'));
    h.turn(backend,0,0,127,0xB0,'');assert(writes.some(([g,k,v])=>g==='[RX3Info]' && k==='move' && v===-1));
    h.press(backend,0,0x80,false);assert.equal(values.get('[RX3Info]:hold'),0);
    h.press(backend,127,0x90,false);h.press(backend,0,0x80,false);
    assert(writes.some(([g,k,v])=>g==='[RX3Info]' && k==='enter' && v===1));
    console.log(folder+': vinyl stop and transport release verified');
}
