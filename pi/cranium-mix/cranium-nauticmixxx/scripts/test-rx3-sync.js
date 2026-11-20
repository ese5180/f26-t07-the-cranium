#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
for(const [folder,file,prefix] of [
    ['Pioneer_DDJ_FLX4_RX3','Pioneer-DDJ-FLX4-script.js','PioneerDDJFLX4'],
    ['Pioneer_Roland_RX3','Pioneer-DDJ-400-script.js','PioneerDDJ400'],
]) {
    const values=new Map(),writes=[];
    const engine={
        getValue(group,key){return values.get(`${group}:${key}`)||0;},
        setValue(group,key,value){values.set(`${group}:${key}`,value);writes.push([group,key,value]);},
    };
    const context=vm.createContext({engine,console,script:{},components:{}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../controllers',folder,file),'utf8'),context);
    const mapping=context[prefix],group='[Channel1]';
    mapping.syncPressed(0,0,127,0x90,group);
    assert.equal(engine.getValue(group,'sync_enabled'),1,`${prefix}: short press retains SYNC`);
    assert.equal(engine.getValue(group,'beatsync_phase'),1,`${prefix}: align phase with Quantize off`);
    const count=writes.length;
    mapping.syncPressed(0,0,0,0x80,group);
    assert.equal(writes.length,count,`${prefix}: release must not enable another action`);
    assert.equal(engine.getValue('[Channel2]','sync_enabled'),0,'other deck remains independent');
    mapping.syncPressed(0,0,127,0x90,group);
    assert.equal(engine.getValue(group,'sync_enabled'),0,'second press disables SYNC');
    values.set(`${group}:rx3_source_lost`,1);
    mapping.syncPressed(0,0,127,0x90,group);
    assert.equal(engine.getValue(group,'sync_enabled'),0,'emergency deck cannot rejoin SYNC');
}
console.log('RX3 FLX4/DDJ-400 persistent SYNC, explicit phase, release and emergency isolation: OK');
