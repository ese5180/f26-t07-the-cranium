#!/usr/bin/env python3
"""Build complete RX3 browser presets from the existing controller mappings."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET


NAUTIC = Path(__file__).resolve().parents[1]
ROOT = NAUTIC.parent
VENDOR = NAUTIC / "vendor/controller-mappings"
OUTPUT = NAUTIC / "controllers/Pioneer_Roland_RX3"


def control_address(control: ET.Element) -> tuple[int, int] | None:
    status = control.findtext("status")
    midino = control.findtext("midino")
    if not status or not midino:
        return None
    return int(status, 0), int(midino, 0)


def sx3_source() -> ET.Element:
    # The community SX3 file has an incomplete SX3 XML document followed by
    # a complete SX2 document. Recover its 148 SX3-specific controls, then
    # apply them to the complete SX2 mapping that uses the same JS script.
    source = (VENDOR / "PIONEER_DJ_DDJ-SX3.midi.xml").read_text()
    first = "<?xml" + source.split("<?xml", 2)[1]
    sx3_fragment = ET.fromstring(
        first + "</controls></controller></MixxxControllerPreset>"
    )
    sx2 = ET.parse(VENDOR / "PIONEER_DDJ-SX2.midi.xml").getroot()
    controls = sx2.find("./controller/controls")
    assert controls is not None
    for sx3_control in sx3_fragment.findall("./controller/controls/control"):
        address = control_address(sx3_control)
        if address is None:
            continue
        for existing in list(controls):
            if control_address(existing) == address:
                controls.remove(existing)
        controls.append(deepcopy(sx3_control))
    return sx2


MODELS = (
    ("DDJ-400", VENDOR / "Pioneer-DDJ-400.midi.xml", None,
     (("turn", 0xB6, 0x40), ("enter", 0x96, 0x41),
      ("shortcut", 0x96, 0x42), ("source", 0x96, 0x68),
      ("view", 0x96, 0x7A))),
    ("DDJ-SX", VENDOR / "Pioneer DDJ-SX.midi.xml", None,
     (("turn", 0xB6, 0x40), ("enter", 0x96, 0x41),
      ("back", 0x96, 0x65), ("source", 0x96, 0x68),
      ("view", 0x96, 0x66))),
    ("DDJ-SX2", VENDOR / "PIONEER_DDJ-SX2.midi.xml", "DDJ-SX2",
     (("turn", 0xB6, 0x40), ("enter", 0x96, 0x41),
      ("back", 0x96, 0x65), ("source", 0x96, 0x68),
      ("view", 0x96, 0x66))),
    ("DDJ-SX3", None, "DDJ-SX3",
     (("turn", 0xB6, 0x40), ("enter", 0x96, 0x41),
      ("back", 0x96, 0x65), ("source", 0x96, 0x68),
      ("view", 0x96, 0x66))),
    ("DDJ-WeGO3", VENDOR / "Pioneer-DDJ-WeGO3.midi.xml", "DDJ-WeGO3",
     (("turn", 0xB6, 0x40), ("enter", 0x96, 0x41),
      ("shortcut", 0x96, 0x42), ("source", 0x96, 0x58),
      ("view", 0x96, 0x59))),
    ("DJ-505", VENDOR / "Roland_DJ-505.midi.xml", None,
     (("turn", 0xBF, 0x00), ("turn", 0xBF, 0x01),
      ("enter", 0x9F, 0x06), ("back", 0x9F, 0x07),
      ("source", 0x9F, 0x12), ("view", 0x9F, 0x1B))),
)


def generate() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    helper=(NAUTIC/"controllers/Pioneer_DDJ_FLX4_RX3/Nautic-RX3-Encoder-FLX4.js").read_text().split("\nNauticRX3Encoder.play1 =")[0]
    wrappers=[]
    for model, source, controller_id, bindings in MODELS:
        root = sx3_source() if source is None else ET.parse(source).getroot()
        info = root.find("info")
        controller = root.find("controller")
        assert info is not None and controller is not None
        name = info.find("name")
        assert name is not None
        name.text = f"{model} - NauticMixxx RX3 browser"
        description = info.find("description")
        if description is not None:
            description.text = (
                "Full controller mapping with NauticMixxx mouse-free RX3 browsing"
            )
        if controller_id:
            controller.set("id", controller_id)
        scriptfiles = controller.find("scriptfiles")
        controls = controller.find("controls")
        assert scriptfiles is not None and controls is not None
        ET.SubElement(scriptfiles, "file", {
            "functionprefix": "NauticRX3Browser",
            "filename": "Nautic-RX3-Browser.js",
        })
        for action, status, midino in bindings:
            for existing in list(controls):
                if control_address(existing) == (status, midino):
                    controls.remove(existing)
            control = ET.Element("control")
            ET.SubElement(control, "group").text = "[Library]"
            ET.SubElement(control, "key").text = f"NauticRX3Browser.{action}"
            ET.SubElement(control, "description").text = (
                f"NauticMixxx RX3 browser: {action}"
            )
            ET.SubElement(control, "status").text = f"0x{status:02X}"
            ET.SubElement(control, "midino").text = f"0x{midino:02X}"
            ET.SubElement(ET.SubElement(control, "options"), "script-binding")
            controls.append(control)
        for control in controls:
            key=control.findtext("key") or ""
            if key=="PioneerDDJSX.rotarySelectorShiftedClick":
                control.find("key").text="NauticRX3Browser.shortcut"
            if key!="play" and not key.endswith(".play.input") and key not in ("PioneerDDJSX.playButton","PioneerDDJWeGO3.playButton"):
                continue
            name=f"NauticRX3Encoder.play{len(wrappers)+1}"
            original=("if(v>0 && (st & 0xF0)!==0x80) engine.setValue(g,\"play\",engine.getValue(g,\"play\")>0?0:1);"
                      if key=="play" else key+"(c,k,v,st,g);")
            brake_group="PioneerDDJWeGO3.actualGroup(g)" if key=="PioneerDDJWeGO3.playButton" else "g"
            wrappers.append(f"\n{name} = function(c,k,v,st,g) {{\n    if (NauticRX3Encoder.brakePress(v,st,{brake_group})) return;\n    {original}\n}};\n")
            control.find("key").text=name
            options=control.find("options")
            if options is not None: control.remove(options)
            ET.SubElement(ET.SubElement(control,"options"),"script-binding")
        # Register the shared v2 encoder, including lifecycle timer cleanup.
        scriptfiles = controller.find("scriptfiles")
        assert scriptfiles is not None
        ET.SubElement(scriptfiles,"file",functionprefix="NauticRX3Encoder",filename="Nautic-RX3-Encoder-Pioneer-Roland.js")
        ET.indent(root, space="    ")
        path = OUTPUT / f"{model}-Nautic-RX3.midi.xml"
        ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
        print(path.relative_to(NAUTIC))
    (OUTPUT/"Nautic-RX3-Encoder-Pioneer-Roland.js").write_text(helper+"\n"+"".join(wrappers))


if __name__ == "__main__":
    generate()
