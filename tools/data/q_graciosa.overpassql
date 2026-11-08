[out:json][timeout:180];
(
  way["building"](29.215,-13.565,29.285,-13.480);
  relation["building"](29.215,-13.565,29.285,-13.480);
  way["highway"](29.215,-13.565,29.285,-13.480);
  way["natural"="coastline"](29.215,-13.565,29.285,-13.480);
  way["man_made"~"^(pier|breakwater|groyne)$"](29.215,-13.565,29.285,-13.480);
);
out geom;
