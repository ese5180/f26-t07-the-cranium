#!/usr/bin/env python3
"""Turn a Mixxx MIDI controller mapping (.midi.xml) into C++ tables.

Mixxx reads its mappings at run time and runs their JavaScript in Qt's script
engine. A microcontroller has neither, so this script reads the XML at build
time and writes the <controls> and <outputs> the engine can act on as two
constant tables. The few script functions the DDJ-FLX4 needs are built into
the engine (see ScriptFunction in engine/include/mz/midi.h); every other entry
is listed at the top of the generated file as left out.

Usage: gen_mapping.py --xml Pioneer-DDJ-FLX4.midi.xml --symbol kPioneerDdjFlx4Mapping \
           --script-prefix PioneerDDJFLX4 --out flx4_mapping.cpp
"""

import argparse
import collections
import re
import sys
import xml.etree.ElementTree as ET

DECK_KEYS = {
    "play": "Play",
    "cue_default": "CueDefault",
    "start_stop": "StartStop",
    "pfl": "Pfl",
    "loop_in": "LoopIn",
    "loop_out": "LoopOut",
    "reloop_toggle": "ReloopToggle",
    "reloop_andstop": "ReloopAndStop",
    "volume": "Volume",
    "pregain": "Pregain",
    "rate": "Rate",
    "LoadSelectedTrack": "LoadSelectedTrack",
}

MASTER_KEYS = {
    "crossfader": "Crossfader",
    "headMix": "HeadMix",
    "gain": "MainGain",
    "headGain": "HeadGain",
}

EQ_KEYS = {"parameter1": "EqLow", "parameter2": "EqMid", "parameter3": "EqHigh"}

SCRIPT_FUNCTIONS = {
    "jogTurn": "JogTurn",
    "jogSearch": "JogSearch",
    "jogTouch": "JogTouch",
    "tempoSliderMSB": "TempoSliderMsb",
    "tempoSliderLSB": "TempoSliderLsb",
    "cycleTempoRange": "CycleTempoRange",
    "shiftPressed": "Shift",
}

OUTPUT_KEYS = {
    "play_indicator": "PlayIndicator",
    "cue_indicator": "CueIndicator",
    "pfl": "Pfl",
    "track_loaded": "TrackLoaded",
    "loop_enabled": "LoopEnabled",
}

OPTIONS = {
    "normal": "Normal",
    "fourteen-bit-msb": "FourteenBitMsb",
    "fourteen-bit-lsb": "FourteenBitLsb",
    "selectknob": "SelectKnob",
    "script-binding": "Script",
}


def channel_deck(group):
    match = re.fullmatch(r"\[Channel(\d+)\]", group)
    return int(match.group(1)) - 1 if match else None


def parse_int(text):
    return int(text.strip(), 0)


def input_entry(control, script_prefix):
    """Returns (entry, None) for a supported control, or (None, reason)."""
    group = (control.findtext("group") or "").strip()
    key = (control.findtext("key") or "").strip()
    options_node = control.find("options")
    options = [o.tag.lower() for o in options_node] if options_node is not None else []
    option = "Normal"
    for name in options:
        if name in OPTIONS:
            option = OPTIONS[name]
            break
        return None, f"option <{name}>"

    status = parse_int(control.findtext("status"))
    midino = parse_int(control.findtext("midino"))
    entry = {"status": status, "midino": midino, "target": "None", "deck": -1,
             "index": 0, "option": option, "script": "None"}

    if option == "Script" or key.startswith(script_prefix + "."):
        prefix, _, function = key.partition(".")
        if prefix != script_prefix or function not in SCRIPT_FUNCTIONS:
            return None, f"script {key}"
        deck = channel_deck(group)
        if deck is None:
            deck = status & 0x0F
        entry.update(option="Script", script=SCRIPT_FUNCTIONS[function], deck=deck)
        return entry, None

    deck = channel_deck(group)
    if deck is not None:
        hotcue = re.fullmatch(r"hotcue_(\d+)_(activate|clear)", key)
        if hotcue:
            index = int(hotcue.group(1)) - 1
            if index >= 8:
                return None, f"{group},{key}"
            target = "HotcueActivate" if hotcue.group(2) == "activate" else "HotcueClear"
            entry.update(target=target, deck=deck, index=index)
            return entry, None
        if key in DECK_KEYS:
            entry.update(target=DECK_KEYS[key], deck=deck)
            return entry, None
        return None, f"{group},{key}"

    eq = re.fullmatch(r"\[EqualizerRack1_\[Channel(\d+)\]_Effect1\]", group)
    if eq and key in EQ_KEYS:
        entry.update(target=EQ_KEYS[key], deck=int(eq.group(1)) - 1)
        return entry, None

    quick = re.fullmatch(r"\[QuickEffectRack1_\[Channel(\d+)\]\]", group)
    if quick and key == "super1":
        entry.update(target="Filter", deck=int(quick.group(1)) - 1)
        return entry, None

    if group in ("[Master]", "[Mixer]") and key in MASTER_KEYS:
        entry.update(target=MASTER_KEYS[key])
        return entry, None

    if group == "[Library]" and key == "MoveVertical":
        entry.update(target="MoveVertical")
        return entry, None

    return None, f"{group},{key}"


def output_entry(output):
    group = (output.findtext("group") or "").strip()
    key = (output.findtext("key") or "").strip()
    deck = channel_deck(group)
    if deck is None:
        return None, f"{group},{key}"
    entry = {
        "deck": deck,
        "index": 0,
        "status": parse_int(output.findtext("status")),
        "midino": parse_int(output.findtext("midino")),
        "on": parse_int(output.findtext("on") or "0x7F"),
        "off": parse_int(output.findtext("off") or "0x00"),
        # legacymidicontrollermappingfilehandler.cpp defaults
        "minimum": float(output.findtext("minimum") or 0.0),
        "maximum": float(output.findtext("maximum") or 1.0),
    }
    hotcue = re.fullmatch(r"hotcue_(\d+)_status", key)
    if hotcue and int(hotcue.group(1)) <= 8:
        entry.update(source="HotcueStatus", index=int(hotcue.group(1)) - 1)
        return entry, None
    if key in OUTPUT_KEYS:
        entry.update(source=OUTPUT_KEYS[key])
        return entry, None
    return None, f"{group},{key}"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--xml", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--script-prefix", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    root = ET.parse(args.xml).getroot()
    name = (root.findtext("./info/name") or args.symbol).strip()

    inputs, skipped_inputs = [], collections.Counter()
    for control in root.iterfind("./controller/controls/control"):
        entry, reason = input_entry(control, args.script_prefix)
        if entry:
            inputs.append(entry)
        else:
            skipped_inputs[reason] += 1

    outputs, skipped_outputs = [], collections.Counter()
    for output in root.iterfind("./controller/outputs/output"):
        entry, reason = output_entry(output)
        if entry:
            outputs.append(entry)
        else:
            skipped_outputs[reason] += 1

    if not inputs:
        sys.exit(f"{args.xml}: no supported controls")

    lines = [
        f"// Generated by tools/gen_mapping.py from {args.xml.split('/')[-1]}. Do not edit.",
        "//",
        "// The mapping comes from Mixxx (GPL-2.0-or-later).",
        f"// {len(inputs)} inputs and {len(outputs)} outputs are supported.",
        f"// Left out: {sum(skipped_inputs.values())} inputs, "
        f"{sum(skipped_outputs.values())} outputs:",
    ]
    for reason, count in sorted(skipped_inputs.items()):
        lines.append(f"//   input  {reason}" + (f" (x{count})" if count > 1 else ""))
    for reason, count in sorted(skipped_outputs.items()):
        lines.append(f"//   output {reason}" + (f" (x{count})" if count > 1 else ""))
    lines += [
        "",
        '#include "mz/midi.h"',
        "",
        "namespace mz {",
        "",
        "namespace {",
        "",
        "const MidiInputMapping kInputs[] = {",
    ]
    for e in inputs:
        lines.append(
            f"    {{0x{e['status']:02X}, 0x{e['midino']:02X}, Target::{e['target']}, "
            f"{e['deck']}, {e['index']}, MidiOption::{e['option']}, "
            f"ScriptFunction::{e['script']}}},")
    lines += ["};", ""]
    if outputs:
        lines.append("const MidiOutputMapping kOutputs[] = {")
        for e in outputs:
            lines.append(
                f"    {{OutputSource::{e['source']}, {e['deck']}, {e['index']}, "
                f"0x{e['status']:02X}, 0x{e['midino']:02X}, 0x{e['on']:02X}, 0x{e['off']:02X}, "
                f"{e['minimum']!r}f, {e['maximum']!r}f}},")
        lines += ["};", ""]
    lines += [
        "} // namespace",
        "",
        f"const ControllerMapping {args.symbol} = {{",
        f"    \"{name}\",",
        "    kInputs,",
        "    sizeof(kInputs) / sizeof(kInputs[0]),",
        "    kOutputs," if outputs else "    nullptr,",
        "    sizeof(kOutputs) / sizeof(kOutputs[0])," if outputs else "    0,",
        "};",
        "",
        "} // namespace mz",
        "",
    ]
    with open(args.out, "w", encoding="utf-8") as out:
        out.write("\n".join(lines))


if __name__ == "__main__":
    main()
