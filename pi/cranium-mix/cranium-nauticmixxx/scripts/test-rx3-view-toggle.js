#!/usr/bin/env node
// Reproduce the RX3 WidgetStack's trigger feedback, including zero-value hides.
// Contract: src/widget/wwidgetstack.cpp; skin.xml's Library on_hide_select="0".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const presets = [
    ['Pioneer_DDJ_FLX6_RX3', 'Pioneer-DDJ-FLX6-RX3-Browser.js',
        'Nautic-RX3-Encoder-FLX6.js', 'NauticFLX6Browser'],
    ['Pioneer_DDJ_FLX4_RX3', 'Pioneer-DDJ-FLX4-RX3-Browser.js',
        'Nautic-RX3-Encoder-FLX4.js', 'NauticFLX4Browser'],
    ['Pioneer_Roland_RX3', 'Nautic-RX3-Browser.js',
        'Nautic-RX3-Encoder-Pioneer-Roland.js', 'NauticRX3Browser'],
];

function fixture(preset, mode) {
    const [folder, script, encoder, prefix] = preset;
    const hasTabs = mode !== 'stock';
    const native = mode === 'native';
    const values = new Map([
        ['[RX3Browser]:enabled', native ? 1 : 0],
        ['[Tab]:current', 0], ['[Tab]:overview', 1],
        ['[Tab]:library', 0], ['[Tab]:samplers', 0],
        ['[Skin]:show_maximized_library', 0],
    ]);
    const transitions = [], writes = [];
    const triggers = ['overview', 'library', 'samplers'];
    function select(page) {
        if (values.get('[Tab]:current') === page) return;
        transitions.push(page);
        values.set('[Tab]:current', page);
        // WidgetStackControlListener::onCurrentWidgetChanged latches the
        // selected trigger and clears the previous one automatically.
        triggers.forEach((key, index) => values.set(`[Tab]:${key}`, index === page ? 1 : 0));
    }
    const engine = {
        beginTimer() { return 1; }, stopTimer() {},
        getValue(group, key) { return values.get(`${group}:${key}`) || 0; },
        setValue(group, key, value) {
            writes.push([group, key, value]);
            const previous = values.get(`${group}:${key}`) || 0;
            if (group === '[Tab]' && key === 'current' && hasTabs) {
                select(value); return;
            }
            values.set(`${group}:${key}`, value);
            if (hasTabs && group === '[Tab]' && triggers.includes(key) && previous !== value) {
                const index = triggers.indexOf(key);
                if (value > 0) select(index);
                else if (values.get('[Tab]:current') === index) {
                    // PERFORMANCE has no on_hide_select: hide advances to
                    // BROWSER. Library and Samplers explicitly return to 0.
                    select(index === 0 ? 1 : 0);
                }
            }
            if (native && group === '[RX3Browser]' &&
                    ['open', 'source'].includes(key) && value > 0) select(1);
        },
    };
    const context = vm.createContext({engine});
    const directory = path.join(__dirname, '../controllers', folder);
    vm.runInContext(fs.readFileSync(path.join(directory, encoder), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(directory, script), 'utf8'), context);
    return {browser: context[prefix], values, transitions, writes, hasTabs};
}

for (const preset of presets) {
    for (const mode of ['native', 'legacy-tabs', 'stock']) {
        const {browser, values, transitions, writes, hasTabs} = fixture(preset, mode);
        const name = `${preset[3]} / ${mode}`;
        for (let cycle = 0; cycle < 3; ++cycle) {
            transitions.length = 0;
            browser.view(6, 0x7A, 127, 0x96);
            browser.view(6, 0x7A, 0, 0x96);
            assert.equal(browser.isOpen(), true, `${name}: first VIEW opens BROWSER`);
            if (hasTabs) assert.deepEqual(transitions, [1], `${name}: opening has no page flicker`);
            transitions.length = 0;
            browser.view(6, 0x7A, 127, 0x96);
            browser.view(6, 0x7A, 0, 0x96);
            assert.equal(browser.isOpen(), false, `${name}: second VIEW stays in PERFORMANCE`);
            assert.equal(values.get('[Tab]:current'), 0, name);
            assert.equal(values.get('[Skin]:show_maximized_library'), 0, name);
            if (hasTabs) assert.deepEqual(transitions, [0], `${name}: closing must not reopen BROWSER`);
        }
        browser.enter(6, 0x41, 127, 0x96);
        browser.enter(6, 0x41, 0, 0x96);
        assert.equal(browser.isOpen(), true, `${name}: BROWSE opens from PERFORMANCE`);
        const before = writes.length;
        browser.enter(6, 0x41, 127, 0x96);
        browser.enter(6, 0x41, 0, 0x96);
        const [group, key] = mode === 'native' ? ['[RX3Browser]', 'enter'] : ['[Library]', 'GoToItem'];
        assert(writes.slice(before).some(([g, k, v]) => g === group && k === key && v === 1),
            `${name}: BROWSE enters the highlighted item while open`);
        assert(!writes.some(([g, k]) => /^\[Channel/.test(g) || /Load.*Track/.test(k)),
            `${name}: toggling views never loads a track or changes transport`);
    }
}
console.log('RX3 VIEW: 3 adapters × 3 skin modes, repeated press/release and BROWSE passed');
