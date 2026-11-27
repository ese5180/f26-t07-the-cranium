#!/usr/bin/env python3
"""Render the same spaced Open Sans CRANIUM lettering for the session background."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

project=Path(__file__).resolve().parents[2]
font=ImageFont.truetype(str(project.parent/'cranium-nauticmixxx-engine/res/fonts/OpenSans-Regular.ttf'),100)
image=Image.new('RGB',(1600,960),'black');draw=ImageDraw.Draw(image)
letters='CRANIUM';spacing=20
width=sum(draw.textlength(letter,font=font) for letter in letters)+spacing*(len(letters)-1)
x=(1600-width)/2
for letter in letters:
    draw.text((x,480),letter,font=font,fill='white',anchor='lm')
    x+=draw.textlength(letter,font=font)+spacing
image.save(project/'cranium/pi/start.png')
