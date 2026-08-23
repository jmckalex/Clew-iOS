# Maps

Interactive maps, Leaflet-plugin style: a ```` ```leaflet ```` fence with
`lat`, `long`, `zoom`, an optional `height`, and any number of
`marker:` lines. Tiles stream from OpenStreetMap (so the first view
needs a network connection); pan and zoom like any map. A marker's
third field is a popup label — or a `[[wikilink]]`, which opens the
note when clicked.

```leaflet
lat: 51.5074
long: -0.1278
zoom: 13
height: 380
marker: 51.5007, -0.1246, Westminster
marker: 51.5145, -0.1163, [[https:///www.lse.ac.uk/|The LSE, roughly]]
marker: 51.5194, -0.1270, The British Museum
```

The default cartography is CARTO **Voyager** — the clean, Google-Maps-
like look. Pick another with `tiles:` — `satellite` (Esri imagery),
`terrain` (OpenTopoMap), `light` / `dark` (CARTO), or `osm` (classic
OpenStreetMap). Other config keys: `minZoom` / `maxZoom`, `tileServer:`
(any custom `{z}/{x}/{y}` tile URL), and `image: [[file.png]]`, which
replaces the world map with a vault image in its own pixel coordinates
— a floor plan, a hand-drawn fantasy map — fully offline, with the
same markers.

## Photo maps

`photos: [[folder]]` scans a vault folder for photos and pins each one
where it was taken (GPS from the photo's EXIF data). The popup shows
the photo — click it to open the full image, or click its name to open
(or create!) a note about it, so a day of holiday photos becomes a day
of annotated pins. iPhone HEIC photos are converted to JPEG
automatically, both here and when you drop them into the editor.
Photos without location data are counted in the corner.

```leaflet
photos: [[Attachments/Holiday]]
height: 380
```
