# Branding sources

`artwork/` holds the original PNG artwork, and `fonts/` holds source fonts with
their licenses. These inputs stay outside `site/`, which is the Pages publication
directory. Keep the avatar source and `social-card.html` here as well.

The website uses the existing WebP artwork in `site/assets/`. Its sun and moon
also have 500 px and 750 px variants resized from the full-size WebP files,
encoded at quality 90. HTML `srcset` selects a variant using the CSS display size
and device pixel ratio; the original 1,254 px images remain available for larger
displays and the social card. No image generation or build step is required to
serve the site. Live fonts and their licenses remain in `site/assets/`.
