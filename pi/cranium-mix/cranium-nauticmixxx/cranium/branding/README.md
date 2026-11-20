# CRANIUM startup wordmark

White, widely spaced Open Sans Regular lettering on the existing black
startup screen. The SVG contains outlined paths, so the Pi needs no extra
font installation. The same artwork appears behind empty decks. The existing
progress bar geometry, colors and behavior are retained.

Generate on the ARM64 builder with Qt Widgets and Qt SVG:

```
g++ generate-wordmark.cpp -o /tmp/cranium-wordmark $(pkg-config --cflags --libs Qt6Widgets Qt6Svg)
QT_QPA_PLATFORM=offscreen /tmp/cranium-wordmark ENGINE/res/fonts/OpenSans-Regular.ttf SKIN/images/Cranium.svg
```

The source font and its license remain in the engine's `res/fonts` directory
and in the packaged font resources. Upstream source credits and license files
remain present.

`generate-start.py` renders the same white, spaced Open Sans lettering onto a
black 1600×960 session background for Sway. It uses Pillow and the same source
font/license. The normal session uses this background before the app appears;
there is no desktop wallpaper or bar in that session.
