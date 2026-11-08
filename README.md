# La Graciosa 3D

Exploración 3D de La Graciosa (Canarias, España) con Three.js y WebGPU. Incluye una pantalla animada de carga que permanece visible hasta el primer fotograma y muestra una opción de reintento si WebGPU no puede iniciarse. Los edificios, pistas, línea de costa y estructuras portuarias cartografiadas se generan a partir de OpenStreetMap; los muelles siguen las geometrías portuarias de OpenStreetMap y el origen del mundo es Caleta de Sebo. El personaje a pie y la gaviota comienzan junto al muelle de Caleta de Sebo, sobre un punto de terreno comprobado dentro de la malla visible; la gaviota aparece sobre el mismo punto.

## Ejecutar

Sirve este directorio con un servidor HTTP local y abre la URL en un navegador compatible con WebGPU. `WASD` o las flechas controlan al personaje; arrastra el ratón con el botón izquierdo sobre la escena para girar la cámara, sin bloquear ni ocultar el cursor. La rueda acerca o aleja y `V` alterna a primera persona. `Mayús` corre y `Espacio` salta. Los sticks analógicos gradúan la velocidad; al desplazarse, el personaje orienta el cuerpo hacia su trayectoria y sincroniza los pasos con la distancia recorrida. La marcha articula brazos, codos, rodillas y tobillos, con balanceo e inclinación del torso y la cabeza, y se suaviza al parar. El botón derecho o el gatillo izquierdo de un gamepad activa la vista sobre el hombro. Al caminar, la cámara vuelve gradualmente hacia el rumbo del movimiento tras 1,8 s sin mirar. La cámara recorta su distancia al acercarse a edificios y recupera el encuadre suavemente al despejarse.

Elige cómo explorar con los botones del HUD o las teclas `1` (a pie) y `3` (gaviota). El transporte en bicicleta se ha retirado temporalmente del menú. A pie, `WASD` mueve, `Mayús` corre y `Espacio` salta; se mantienen colisiones con edificios, costa y pendientes. `F` activa la gaviota y vuelve al modo terrestre anterior.

En modo gaviota, `WASD` desplaza el vuelo, `E`/`Q` o `Espacio`/`Ctrl` sube y baja, y `Mayús` acelera. Su modelo incluye alas ahusadas con plumas oscuras, cola, pico y patas; las alas aletean según la velocidad y el cuerpo se inclina suavemente al virar o ascender. El minimapa sigue a la cámara y, al salir del modo, regresas al último punto terrestre. En pantallas táctiles aparecen controles adaptados para moverse, saltar, subir/bajar y correr.

El minimapa compacto se centra en el jugador: arrástralo para desplazarlo, usa la rueda o `+`/`−` para acercar o alejar y pulsa `Centrar` para volver al jugador. Puedes pulsar tierra o uno de los puntos de interés para teletransportarte; los destinos se ajustan a terreno transitable y fuera de edificios. La brújula indica el rumbo y el contador muestra los FPS actuales en la esquina inferior derecha, encima de los controles táctiles en pantallas pequeñas.

La costa completa, incluidos los islotes, se suaviza y densifica para evitar tramos angulosos y se integra con una plataforma litoral graduada de arena a aguas turquesas. El agua combina transparencia sutil, variación turquesa, normales animadas y reflejos solares; una espuma más ancha y cambiante acompaña la rompiente. Los barcos del puerto flotan con balanceo, cabeceo y deriva suaves. El terreno mezcla la imagen satelital con variación procedural de arena y roca volcánica; si no hay conexión, mantiene el material procedural. Todas las vías, incluidas las que OpenStreetMap marque como pavimentadas, se representan como pistas de arena en tonos cálidos para reflejar el aspecto de La Graciosa. El relieve se acentúa con rocas volcánicas de baja geometría, pequeños lomos de arena y vegetación xerófita instanciados sobre terreno transitable, evitando caminos y pendientes pronunciadas. El cielo incorpora un gradiente cálido y nubes sutiles, con bruma costera y exposición equilibradas. Las casas encaladas varían entre tonos blancos y crema; persianas, puertas, ventanas, pretiles y depósitos de azotea usan matices diversos para reducir la repetición.

El renderer WebGPU usa tone mapping ACES Filmic, salida sRGB y sombras PCF. La iluminación combina luz hemisférica de cielo azul y suelo cálido con una luz direccional de sol costero dorado; la cámara de sombras cubre la isla y emplea sesgos para reducir artefactos en edificios y terreno.

El relieve muestra una imagen satelital georreferenciada de Esri World Imagery, solicitada para los límites de La Graciosa y alineada con las coordenadas del terreno. Requiere conexión a Internet; si el servicio no está disponible, se conserva la textura procedural. La atribución aparece debajo del minimapa.

## Actualizar datos geográficos

Desde la raíz del proyecto:

```sh
node tools/build-graciosa.mjs --fetch
```

El comando consulta Overpass para el bbox `29.215,-13.565,29.285,-13.480`, guarda la respuesta en `tools/data/osm_graciosa.json` y compila `js/graciosa-geodata.js`. Sin `--fetch`, recompila a partir de la instantánea local.

## Relieve topográfico

La escena usa una cuadrícula DEM de 15 m derivada de [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) en codificación Terrarium, con elevaciones basadas en SRTM. Para regenerarla se necesita acceso a Internet:

```sh
node tools/build-graciosa-elevation.mjs
```

El comando descarga las teselas de elevación que cubren la costa, interpola una cuadrícula en el mismo marco local de Caleta de Sebo y genera `js/graciosa-elevation.js`. La escena aplica el relieve al terreno, ajusta las pistas y edificios a su elevación y mantiene al jugador sobre la superficie. La fuente SRTM tiene una resolución aproximada de 30 m; el muestreo a 15 m interpola la fuente y no representa detalle adicional.

Los datos geográficos proceden de © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), disponibles bajo ODbL; la atribución también aparece junto al minimapa. Consulta [LICENSE](LICENSE) para la licencia del código.

## Publicar en producción

El proyecto se publica como sitio estático en GitHub Pages mediante [el workflow de publicación](.github/workflows/deploy-pages.yml). En GitHub, abre **Settings → Pages** y selecciona **GitHub Actions** como origen de despliegue. Después, cada `push` a `main` ejecuta las pruebas del juego, prepara el sitio y lo publica; los pull requests ejecutan las pruebas y la compilación sin desplegar. También puedes iniciar el workflow manualmente desde **Actions**. La URL prevista es <https://davidcruz127.github.io/slop-Graciosa-Island/>.

Para revisar localmente el mismo paquete que se publica:

```sh
node tools/build-site.mjs
```

El sitio preparado queda en `dist/` e incluye solo `index.html`, los estilos y el grafo de módulos locales que usa la isla, sin los datos heredados de NYC. El despliegue requiere un navegador con WebGPU y conexión a Internet para Three.js, las fuentes y las imágenes de Esri; si Esri no está disponible, se usa el terreno procedural. El flujo de trabajo funciona con la ruta de proyecto de GitHub Pages gracias a las rutas relativas de los recursos.
