// NauticMixxx v2.0: one context-aware encoder gesture for every RX3 preset.
var NauticRX3Encoder = {
    timer: null, pressed: false, consumed: false, moved: false,
    shifted: false, started: 0, backend: null, browserAtPress: false
};
NauticRX3Encoder.pulse = function(key, value) {
    engine.setValue("[RX3Shortcut]", key, value);
    engine.setValue("[RX3Shortcut]", key, 0);
};
NauticRX3Encoder.cancel = function() {
    if (NauticRX3Encoder.timer !== null) engine.stopTimer(NauticRX3Encoder.timer);
    NauticRX3Encoder.timer = null;
};
NauticRX3Encoder.init = function() {
    // Restore after the full transport mapper initializes its defaults.
    NauticRX3Encoder.timer = engine.beginTimer(1, function() {
        NauticRX3Encoder.timer = null;
        NauticRX3Encoder.pulse("restore", 1);
    }, true);
};
NauticRX3Encoder.shutdown = function() {
    NauticRX3Encoder.cancel();engine.setValue("[RX3Info]", "hold", 0);NauticRX3Encoder.pressed = false;
};
NauticRX3Encoder.longPress = function() {
    NauticRX3Encoder.timer = null;
    if (!NauticRX3Encoder.pressed || NauticRX3Encoder.moved || NauticRX3Encoder.consumed) return;
    NauticRX3Encoder.consumed = true;
    if (NauticRX3Encoder.shifted) {
        NauticRX3Encoder.pulse("toggle", 1);
    } else if (engine.getValue("[RX3Info]", "visible") > 0) {
        // INFO keeps the held selector available for rating edits.
    } else if (engine.getValue("[RX3Shortcut]", "visible") > 0) {
        // A long unshifted press does not leak into the covered page.
    } else if (NauticRX3Encoder.browserAtPress) {
        NauticRX3Encoder.backend.back(0, 0, 127);
    } else {
        const enabled = engine.getValue("[RX3Controller]", "grid_mode") <= 0;
        if (NauticRX3Encoder.backend.setGrid) NauticRX3Encoder.backend.setGrid(enabled);
        else engine.setValue("[RX3Controller]", "grid_mode", enabled ? 1 : 0);
    }
};
NauticRX3Encoder.press = function(backend, value, status, shifted) {
    const down = value > 0 && (status & 0xF0) !== 0x80;
    if (down) {
        if (NauticRX3Encoder.pressed) return;
        NauticRX3Encoder.cancel();
        NauticRX3Encoder.backend = backend;NauticRX3Encoder.pressed = true;
        NauticRX3Encoder.consumed = false;NauticRX3Encoder.moved = false;
        NauticRX3Encoder.shifted = shifted;NauticRX3Encoder.started = Date.now();
        NauticRX3Encoder.browserAtPress = backend.isOpen();
        if (engine.getValue("[RX3Info]", "visible") > 0) engine.setValue("[RX3Info]", "hold", 1);
        NauticRX3Encoder.timer = engine.beginTimer(2000, NauticRX3Encoder.longPress, true);
        return;
    }
    if (!NauticRX3Encoder.pressed) return;
    NauticRX3Encoder.cancel();
    if (Date.now() - NauticRX3Encoder.started >= 2000) NauticRX3Encoder.longPress();
    engine.setValue("[RX3Info]", "hold", 0);
    NauticRX3Encoder.pressed = false;
    if (NauticRX3Encoder.consumed || NauticRX3Encoder.moved || NauticRX3Encoder.shifted) return;
    if (engine.getValue("[RX3Info]", "visible") > 0) {
        engine.setValue("[RX3Info]", "enter", 1);engine.setValue("[RX3Info]", "enter", 0);
    } else if (engine.getValue("[RX3Shortcut]", "visible") > 0) {
        NauticRX3Encoder.pulse("enter", 1);
    } else if (engine.getValue("[RX3Controller]", "grid_mode") > 0) {
        engine.setValue("[RX3Controller]", "grid_mode", 0);
    } else backend.shortPress(0, 0, 127);
};
NauticRX3Encoder.turn = function(backend, channel, control, value, status, group) {
    if (!value) return;
    if (NauticRX3Encoder.pressed) {NauticRX3Encoder.moved = true;NauticRX3Encoder.cancel();}
    const direction = value > 0x3F ? -1 : 1;
    if (engine.getValue("[RX3Info]", "visible") > 0) {
        engine.setValue("[RX3Info]", "move", direction);engine.setValue("[RX3Info]", "move", 0);return;
    }
    if (engine.getValue("[RX3Shortcut]", "visible") > 0) {
        NauticRX3Encoder.pulse("move", direction);return;
    }
    if (engine.getValue("[RX3Controller]", "grid_mode") > 0) {
        const deck = Math.round(engine.getValue("[RX3Controller]", "active_deck")) === 2 ? 2 : 1;
        engine.setValue(`[Channel${deck}]`, "beats_translate_move", direction);return;
    }
    backend.originalTurn(channel, control, value, status, group);
};

NauticRX3Encoder.brakeConsumed = {};
NauticRX3Encoder.brakePress = function(value, status, group) {
    const deck = Number((group.match(/Channel([1-4])/ ) || [0,0])[1]);
    if (!deck || deck > 2) return false;
    const down = value > 0 && (status & 0xF0) !== 0x80;
    if (!down && NauticRX3Encoder.brakeConsumed[deck]) {
        NauticRX3Encoder.brakeConsumed[deck] = false;return true;
    }
    if (down && engine.getValue(group,"play") > 0 &&
            engine.getValue("[RX3Settings]", "vinyl_speed"+deck) > 0) {
        const level = engine.getValue("[RX3Settings]", "vinyl_stop"+deck) || 3;
        // brake's factor scales filter deceleration; higher UI levels stop slower.
        engine.brake(deck, true, 2.5 / Math.max(1, Math.min(5,level)));
        NauticRX3Encoder.brakeConsumed[deck] = true;return true;
    }
    return false;
};

NauticRX3Encoder.play1 = function(c,k,v,st,g) {
    if (NauticRX3Encoder.brakePress(v,st,DJCi500.deckA.currentDeck)) return;
    DJCi500.deckA.playButton.input(c,k,v,st,g);
};

NauticRX3Encoder.play2 = function(c,k,v,st,g) {
    if (NauticRX3Encoder.brakePress(v,st,DJCi500.deckB.currentDeck)) return;
    DJCi500.deckB.playButton.input(c,k,v,st,g);
};
