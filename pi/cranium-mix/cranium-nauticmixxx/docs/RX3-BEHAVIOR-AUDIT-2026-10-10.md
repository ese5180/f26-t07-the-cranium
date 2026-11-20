# Comparación funcional con XDJ-RX3 — 10 de octubre de 2026

Auditoría del árbol de trabajo actual de NauticMixxx, VERSION 2.0.0 en desarrollo. Incluye cambios locales y archivos todavía no versionados. No describe exclusivamente el binario publicado 1.9.1 ni el candidato 2.0.0-rc1, que precede a varias modificaciones actuales.

El proyecto reproduce buena parte de la pantalla y del flujo de reproducción de la RX3. Las mayores diferencias están en la correspondencia real de los pads, los algoritmos de efectos, la preescucha táctil y la persistencia en el USB. Tener un nombre o una pantalla RX3 no garantiza que el control ejecute su función.

## Alcance y método

- Revisión de la skin, mappings, widgets RX3, motor de transporte y adaptación del catálogo rekordbox.
- Comparación con la página oficial de producto y los diagramas oficiales de controles. Algunos enlaces al manual del fabricante devolvieron errores de acceso; las afirmaciones específicas no verificadas por esas fuentes se identifican como pendientes de contraste.
- Reejecución de tres suites JavaScript: pad feedback, Sound Color FX y AUTOLOOP. Las tres pasaron.
- Ejecución del binario de pruebas macOS ya disponible, sin recompilar: `Rx3BeatFxTest.*`, 16 pruebas aprobadas. Verifica ese binario existente; no acredita por sí sola que cada archivo del árbol actual esté incorporado en él.
- No se hizo comparación audible con una RX3 física ni se validaron latencia, touchscreen o controladores reales durante esta auditoría.
- No se modificó código funcional ni se generó un candidato.

La habilidad graphify se consultó, pero no existe un grafo generado en el proyecto. No se construyó un grafo nuevo: los hallazgos se basan en lectura directa del código.

## Funciones que ya tienen implementación

La versión en desarrollo incluye dos decks, importación USB rekordbox, playlists y categorías, 12 filas de navegación, búsqueda táctil, Hot Cues A–H, hot loops, beatgrids exportados, ondas BLUE/RGB/3BAND y lectura de frases PSSI. También hay transporte Vinyl, ajustes de loop, Beat Jump, SYNC con alineación explícita, SLIP con playhead de fondo, Emergency Loop, INFO, SHORTCUT, contador regresivo y Bank/X-PAD con cuatro favoritos persistentes.

Estas funciones deben mantenerse en la base de trabajo; no corresponde enumerarlas como funciones completamente ausentes. Su fidelidad audible y física requiere pruebas específicas.

## 1. Corregir la correspondencia de los modos de pads — prioridad máxima

Hay discrepancias comprobables entre pantalla y acciones del mapping Hercules:

| Modo mostrado | Acción actual del mapping | Implementación necesaria |
| --- | --- | --- |
| GATE CUE, modo 5 | Pitch up/down, ajustes del rango de tempo y keylock | Reproducción del Hot Cue mientras se mantiene el pad, detención y retorno al soltarlo |
| BEAT LOOP 2, modo 6 | `beatlooproll_*_activate`, con fracciones del mapping original | Loops de la segunda tabla RX3, con la semántica correspondiente y valores coherentes con pantalla |
| RELEASE FX, modo 7 | Encendido de slots de efectos, selección de cadenas QuickEffect y cambio de rutas | Ocho acciones Release FX por deck con duración, liberación y estados propios |
| BEAT LOOP, modo 2 | Tabla 1/8, 1/4, 1/2, 1, 2, 4, 8, 16 | La pantalla anuncia 1/4, 1/2, 1, 2, 4, 8, 16, 32; ambas tablas deben coincidir |

Fuentes: `controllers/Hercules_DJControl_Inpulse_500_RX3/Hercules-DJControl-Inpulse-500-RX3-script.js:664`, `:865`, `:1249`, `:1397`, `:1414`; `skins/XDJ_RX3_Mixxx/rx3_mode_strip.xml:18`.

Los pads de BEAT LOOP, BEAT LOOP 2 y RELEASE FX de la pantalla usan `rx3_mode_pad.xml`, que contiene texto y estados pero ninguna conexión a una acción. GATE CUE reutiliza el mismo template HotcueButton que HOT CUE, sin una configuración específica de Gate Cue. SLIP LOOP y BEAT JUMP sí tienen acciones propias.

La pantalla física RX3 utiliza esta zona como estado de sus pads; hacer todos los indicadores táctiles es una decisión adicional del producto. La incoherencia con los pads del controlador sí afecta directamente la paridad funcional.

Conviene definir un contrato común de modos, valores y acciones para los mappings. Después, probar el gesto completo press/hold/release y comprobar pantalla, LED y audio. Los tests actuales de feedback pueden pasar aunque la función musical rotulada no corresponda.

## 2. Implementar Release FX reales — prioridad máxima

La RX3 ofrece Vinyl Brake Short/Long, Backspin Short/Long, Echo Out, Build Up, Mute y Ducking. En el proyecto esos nombres están visibles, pero el modo 7 no los despacha como tales.

Se requieren acciones por deck y un tratamiento definido de sus envolventes, tempo, parada/reanudación, colas de efecto y relación con SLIP. Las utilidades genéricas `engine.brake` y `engine.spinback` existentes pueden servir como piezas de implementación, pero no equivalen a los ocho pads terminados.

Referencia: [producto oficial RX3](https://www.pioneerdj.com/en/product/all-in-one-dj-systems/xdj-rx3/).

## 3. Completar Beat FX y su control — prioridad alta

El Bank y X-PAD funcionan con ocho procesadores: Echo, Reverb, Flanger, Phaser, Filter, Pitch Shift, Tremolo y Glitch. El filtro de selección está explícito en `dev/src/widget/rx3beatfxeffects.h:8`.

La RX3 ofrece Delay, Echo, Ping Pong, Spiral, Reverb, Trans, Filter, Flanger, Phaser, Pitch, Slip Roll, Roll, Vinyl Brake y Helix. No basta con renombrar Tremolo como Trans o Glitch como Roll: faltan algoritmos y parámetros específicos y la validación de los efectos que tienen nombres similares.

Las limitaciones existentes están reconocidas en `docs/BEAT-FX-2.0-EN.md`: por ejemplo, Echo admite 1/8 a 2 beats en el X-PAD; Filter expone cutoff y no el LFO Filter RX3. El panel táctil CH SELECT solo ofrece MASTER (`skins/XDJ_RX3_Mixxx/beffect.xml:20`); el motor Mixxx dispone de otras rutas, pero falta integrarlas en un flujo completo de selección y controles físicos.

Prioridades: procesadores ausentes, tablas de beats y límites, TIME/LEVEL DEPTH, TAP/AUTO BPM, selección de destino y prueba de colas al bajar faders y cambiar activación. Esto último es validación pendiente, no un fallo confirmado de todas las rutas.

Referencia de catálogo y controles: [diagrama oficial rekordbox RX3](https://downloads.support.alphatheta.com/software_info/all-in-one-dj-systems/XDJ-RX3/XDJ-RX3_HardwareDiagram_rekordbox_E1.pdf).

## 4. Completar los seis Sound Color FX — prioridad alta

Actualmente se distribuyen cuatro cadenas: REVERB, PING PONG, NOISE y FILTER. El mapping Hercules usa esos cuatro presets y, para los tres primeros, convierte la distancia al centro del knob en cantidad.

El conjunto RX3 es SPACE, DUB ECHO, SWEEP, NOISE, CRUSH y FILTER. Faltan SWEEP y CRUSH como controles integrados; REVERB/PING PONG no acreditan el comportamiento de SPACE/DUB ECHO. También faltan la correspondencia completa de los dos lados del knob COLOR y el control PARAMETER según cada efecto.

Fuentes: `controllers/Hercules_DJControl_Inpulse_500_RX3/Hercules-DJControl-Inpulse-500-RX3-script.js:183`; `effects/chains/`; diagrama oficial enlazado arriba.

## 5. Añadir Touch Preview audible — prioridad alta

La columna PREVIEW dibuja la onda importada, pero el delegate RX3 implementa pintura y sustituye al PreviewButtonDelegate genérico. No hay en ese flujo una acción que convierta la posición horizontal del toque en posición de reproducción del PreviewDeck.

Fuentes: `dev/src/widget/wtracktableview.cpp:94`, `:910`, `:1486`; `dev/src/library/tabledelegates/previewbuttondelegate.cpp`.

Falta conectar toque/arrastre, carga asíncrona, seek y activación de preescucha, con salida por auriculares/LINK CUE. El motor ya posee PreviewDeck; falta esta integración RX3. Criterio de aceptación: escuchar un punto elegido de una pista del navegador manteniendo intactos los dos decks y la salida MASTER.

Referencia: la página oficial describe la audición de cualquier sección tocando la onda sin cargar el tema en un deck principal.

## 6. Memory Cues y Active Loops — prioridad alta

El catálogo conserva Memory Cues, pero el adaptador proyecta únicamente el primero como MainCue de Mixxx y descarta los restantes en esa adaptación. Falta un modelo operativo de Memory Cues ordenados y controles CUE/LOOP CALL, MEMORY y DELETE.

`RuntimeCue` representa tipo, posición, final, color y etiqueta, pero no contiene una propiedad Active Loop. No encontré el recorrido de importación y activación automática de ese estado. Debe incorporarse y contrastarse con exportaciones reales.

Fuentes: `dev/src/library/rekordbox/rekordboxtrackadapter.cpp:289`; `dev/src/library/rekordbox/rekordboxruntimecatalog.h:68`; `dev/src/library/rekordbox/rekordboxanlzreader.cpp:66`.

Los hot loops importados y loops manuales ya existen; este pendiente se refiere al flujo de memoria y a la marca de activación automática.

## 7. Guardar el trabajo de la sesión en USB — prioridad alta

Las pistas USB usan una política transitoria que impide persistencia y exportación genérica. Hay un escritor dedicado de rating para `export.pdb`, pero no escritura ANLZ de cues ni beatgrid.

Faltan guardado/edición/eliminación de cues y loops, persistencia del grid y creación de historial de sesión exportable. HISTORY consulta historiales que ya están en el catálogo; el ledger de reproducción solo conserva marcas durante la sesión y declara expresamente que no escribe en USB.

Fuentes: `dev/src/track/trackusepolicy.h:8`; `dev/src/widget/rx3browserplayback.h:16`; `dev/src/widget/wrx3browser.h:792`; `docs/INFO-USB-2.0-EN.md`.

El rating ya tiene validación de escritura y reconexión; su retorno real mediante CUE GRID INFO de rekordbox sigue pendiente. Cada nuevo escritor necesita preservar identificadores, bytes desconocidos y asociación con la colección original.

## 8. Completar la navegación para preparar el próximo tema — prioridad media/alta

No encontré integración de Playlist Bank de cuatro favoritos, TAG LIST/TAG TRACK y creación de playlist desde la selección temporal, ni panel TRACK FILTER con condiciones combinables. SEARCH y categorías existentes no cubren todas esas interacciones.

MATCHING está implementado como regla propia de claves compatibles y BPM dentro de ±6%, no como lectura de pares guardados en rekordbox. RELATED KEY muestra una lista vacía. Las categorías que no tienen handler terminan en COMING SOON.

Fuentes: `dev/src/widget/rx3browsernavigation.h:28`; `dev/src/widget/wrx3browser.h:536`, `:675`, `:734`, `:839`. La ausencia de handlers se refiere al flujo RX3; no afirma que Mixxx carezca de playlists o filtros generales.

Referencia: la página oficial confirma Playlist Bank; el diagrama oficial confirma TAG TRACK y TRACK FILTER.

## 9. Grabación, entradas y opciones de dispositivo — prioridad media

El motor Mixxx tiene grabación y entradas. Falta integrarlos con la experiencia RX3: selección de USB para grabar, controles y estado REC, acceso a la grabación resultante, espacio libre y retirada del dispositivo. REC no tiene handler específico en la selección de categorías actual.

Para ampliar hacia un sistema completo también hace falta exponer y comprobar entradas externas, dos micrófonos, AUX, monitorización y booth según la interfaz de audio usada. Las conexiones y respuesta mecánica de la RX3 dependen de hardware y no se reproducen únicamente con una skin.

MY SETTINGS importa una parte de los valores. No hay SAVE al USB en el panel; el lector omite, entre otros, play mode, umbral de Auto Cue y ciertas opciones de visualización. VINYL y SYNC de arranque se leen pero se notifican como no aplicados. Estas opciones requieren priorización; brillo y peso mecánico del jog no son funciones de software pendientes equivalentes.

Fuentes: `dev/src/widget/rx3mysettings.h:50`; `dev/src/widget/wrx3shortcut.h:276`; `dev/src/library/library.cpp:138`; `dev/src/widget/wrx3browser.h:734`.

rekordbox Link Export tampoco tiene integración RX3 encontrada. Implicaría ampliar la actual política USB-only: es una decisión de alcance, de menor prioridad que los pendientes de reproducción USB.

## 10. Validar la sensación de operación — trabajo pendiente transversal

Las suites aprobadas confirman partes de la implementación actual, no equivalencia completa con el hardware. Se necesita una matriz comparativa con RX3 real o capturas reproducibles de sus gestos y audio:

1. Jog: scratch, pitch bend, sensibilidad, release y Master Tempo.
2. CUE/PLAY, Auto Cue y cuantización con pistas constantes y variables.
3. Todos los modos de pads: valores, pulsación, hold, release y LEDs.
4. FX: rango, respuesta del knob, tempo, rutas y colas post-fader.
5. Carga desde dos USB, expulsión y Emergency Loop durante reproducción.
6. Auriculares, salida MASTER, grabación y niveles en cada controlador/interfaz.
7. Windows y pantallas táctiles físicas; los controles pendientes de hardware están documentados en los informes existentes.

El preset FLX6 es de navegación; no debe interpretarse como un mapping completo del mixer y decks. Los demás mappings tampoco adquieren paridad RX3 completa solo por reutilizar el navegador.

## Orden de implementación sugerido

1. Contrato de pads compartido; corregir GATE CUE, las tablas BEAT LOOP y BEAT LOOP 2 y sus estados.
2. Release FX completos y Touch Preview audible.
3. Memory Cues/Active Loops y escritura USB de cues, loops, grids e historial.
4. Seis Sound Color FX y catálogo/control de Beat FX.
5. Playlist Bank, Tag List, Track Filter y navegación relacionada.
6. REC, opciones adicionales y validación física transversal.

La integración audible de efectos y monitorización debe validarse durante su desarrollo, sin esperar a la última etapa. Cuatro decks, stems y sampler no son requisitos de la RX3 standalone y no se consideran carencias en esta comparación.

## Fuentes del fabricante

- [XDJ-RX3: producto y funciones](https://www.pioneerdj.com/en/product/all-in-one-dj-systems/xdj-rx3/).
- [Diagrama de controles para rekordbox](https://downloads.support.alphatheta.com/software_info/all-in-one-dj-systems/XDJ-RX3/XDJ-RX3_HardwareDiagram_rekordbox_E1.pdf). Sirve para identificar controles y catálogo; las asignaciones software del documento no se utilizan como prueba de la semántica standalone de cada pad.
- [Lista oficial de mensajes MIDI](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx3/xdj-rx3_midi_message_list_e1.pdf/).
