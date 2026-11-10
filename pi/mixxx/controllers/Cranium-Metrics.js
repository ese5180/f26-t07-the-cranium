// Cranium Metrics: reads Mixxx control objects once per second and writes one
// JSON line to mixxx.log:
//
//   ... CRANIUM_METRICS {"t":...,"latency_usage_pct":2.4,"xruns":0,...}
//
// It logs at WARNING level on purpose: Mixxx's default log level is Warning,
// so the lines reach mixxx.log without --controller-debug (which would also
// flood the log with debug output). Launch Mixxx with
// --log-flush-level warning so each line is written immediately.
// pi/cranium_collect.py tails these lines (pi/README.md); start Mixxx with pi/bin/cranium-mixxx.

var CraniumMetrics = {};

CraniumMetrics.MAX_DECKS = 4;   // Mixxx supports up to 4 decks
CraniumMetrics.INTERVAL_MS = 1000;

CraniumMetrics.round = function(value, places) {
    var f = Math.pow(10, places);
    return Math.round(value * f) / f;
};

CraniumMetrics.init = function(id, debugging) {
    CraniumMetrics.timer = engine.beginTimer(CraniumMetrics.INTERVAL_MS, CraniumMetrics.report);
    console.warn("CRANIUM_METRICS_START " + id);
};

CraniumMetrics.report = function() {
    var r = CraniumMetrics.round;
    var m = {
        t: Date.now(),
        // audio_latency_usage is a 0..1 fraction of each buffer's time budget
        latency_usage_pct: r(engine.getValue("[App]", "audio_latency_usage") * 100, 1),
        xruns: engine.getValue("[App]", "audio_latency_overload_count"),
        output_latency_ms: r(engine.getValue("[App]", "output_latency_ms"), 1),
        samplerate: engine.getValue("[App]", "samplerate"),
        decks: []
    };
    // Follow Mixxx's own deck count (2 or 4), so any controller works.
    var numDecks = Math.min(engine.getValue("[App]", "num_decks") || 2, CraniumMetrics.MAX_DECKS);
    for (var i = 1; i <= numDecks; i++) {
        var g = "[Channel" + i + "]";
        m.decks.push({
            deck: i,
            loaded: engine.getValue(g, "track_loaded"),
            playing: engine.getValue(g, "play"),
            bpm: r(engine.getValue(g, "bpm"), 2),
            position: r(engine.getValue(g, "playposition"), 3),
            sync: engine.getValue(g, "sync_enabled")
        });
    }
    console.warn("CRANIUM_METRICS " + JSON.stringify(m));
};

CraniumMetrics.shutdown = function() {
    if (CraniumMetrics.timer) {
        engine.stopTimer(CraniumMetrics.timer);
    }
};