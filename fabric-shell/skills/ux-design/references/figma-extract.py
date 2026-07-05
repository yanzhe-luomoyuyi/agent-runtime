"""Extract detailed visual properties from a Figma API JSON export.

Usage: python3 figma-extract.py /tmp/figma-full.json
Outputs one line per node: [TYPE] name | size=WxH | fills=[#hex] | font: ... | text="..."
"""
import json, sys

with open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/figma-full.json") as f:
    data = json.load(f)

def rgba(c, opacity=1.0):
    r, g, b = int(c['r']*255), int(c['g']*255), int(c['b']*255)
    a = c.get('a', 1.0) * opacity
    return f"rgba({r},{g},{b},{a:.2f})" if a < 1 else f"#{r:02x}{g:02x}{b:02x}"

def walk(node, depth=0):
    indent = "  " * depth
    t, name = node.get("type",""), node.get("name","")
    parts = [f"{indent}[{t}] {name}"]

    bb = node.get("absoluteBoundingBox", {})
    if bb: parts.append(f'size={bb.get("width",0):.0f}x{bb.get("height",0):.0f}')

    fills = [rgba(f["color"], f.get("opacity",1)) for f in node.get("fills",[])
             if f.get("visible",True) and f.get("type")=="SOLID"]
    if fills: parts.append(f"fills={fills}")

    strokes = [rgba(s["color"], s.get("opacity",1)) for s in node.get("strokes",[])
               if s.get("visible",True) and s.get("type")=="SOLID"]
    if strokes: parts.append(f"strokes={strokes} weight={node.get('strokeWeight',0)}")

    r = node.get("cornerRadius",0)
    if r: parts.append(f"radius={r}")

    pad = {s: node[s] for s in ["paddingTop","paddingRight","paddingBottom","paddingLeft"] if node.get(s)}
    if pad: parts.append(f"padding={pad}")
    lm = node.get("layoutMode","")
    if lm: parts.append(f"layout={lm} gap={node.get('itemSpacing',0)}")

    for e in node.get("effects",[]):
        if e.get("visible",True) and e["type"] in ("DROP_SHADOW","INNER_SHADOW"):
            parts.append(f'{e["type"]}: offset({e["offset"]["x"]},{e["offset"]["y"]}) blur({e["radius"]}) {rgba(e["color"])}')

    st = node.get("style",{})
    if t == "TEXT" and st:
        parts.append(f'font: {st.get("fontWeight",400)} {st.get("fontSize",14)}px/{st.get("lineHeightPx",20):.0f}px "{st.get("fontFamily","Segoe UI")}"')
    text = node.get("characters","")
    if text: parts.append(f'text="{text[:120]}"')

    print(" | ".join(parts))
    for child in node.get("children",[]): walk(child, depth+1)

for val in data.get("nodes",{}).values():
    walk(val.get("document",{}))
