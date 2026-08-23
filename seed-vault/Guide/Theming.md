---
tags: [guide]
---
# Theming

Settings → Appearance switches **dark/light** (the palette also has
"Toggle light/dark theme"). Every color in the UI is a CSS custom
property, so themes switch instantly — previews included.

Drop `.css` files into `.clew/snippets/` in the vault to restyle
anything; they load at vault open. For example:

```css
/* .clew/snippets/accent.css */
body[data-theme='dark'] { --clew-accent: #4a9ed8; }
```

Editor font size and line width are in Settings → Appearance; see
[[Settings and Hotkeys]].
