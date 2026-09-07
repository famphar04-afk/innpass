# InnPass

PWA mínima para el piloto UAH × School of INN (OMS). Traduce la marca de la caja
del paciente a su **DCI/INN** (nombre internacional) y la enseña al farmacéutico
en una tarjeta a pantalla completa con un QR.

- Sin backend, sin cuentas, sin cookies ni analytics.
- HTML + CSS + JS vanilla. Sin bundler.
- Funciona offline una vez abierta (service worker).

## Arrancar en local

Necesita un servidor HTTP (no abras `index.html` con `file://`: el `fetch` de
`drugs.json` y el service worker no funcionan así).

```bash
cd innpass
python3 -m http.server 5173
```

Abre <http://localhost:5173>.

Alternativas equivalentes: `npx serve -l 5173 .` o `php -S localhost:5173`.

### Probar en otro móvil (criterio 3)

1. Averigua la IP de tu ordenador en la red wifi (`ipconfig getifaddr en0` en macOS).
2. Abre `http://<tu-ip>:5173` en el móvil, o simplemente escanea el QR del pase
   generado en el ordenador: el QR lleva la URL completa con el hash.
3. En `http://` con IP (no `localhost`) el navegador **no** registra el service
   worker (requiere HTTPS). La app funciona igual online; solo se pierde el
   modo offline y la instalación. Para probar PWA completa en móvil, publica la
   carpeta en cualquier hosting estático con HTTPS (GitHub Pages, Netlify…) o
   usa un túnel HTTPS.

## Ficheros

```
innpass/
  index.html            3 vistas en una sola página (inicio, ficha, pase)
  styles.css            editor oscuro (#0b1f17 / lima #d8f56a), pase claro
  app.js                catálogo, buscador, lista, hash, QR, modos
  drugs.json            catálogo (40 fármacos) · NO se edita desde la app
  manifest.webmanifest  instalable
  sw.js                 precache + red primero (3 s) con caché de respaldo
  vendor/qrcode.js      qrcode-generator 1.4.4 (MIT, Kazuhiko Arase)
  icons/                icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png
```

## Cómo funciona

### Dos modos en la misma URL

| URL | Qué se ve |
| --- | --- |
| `/` (sin hash) | Editor del paciente: buscador, ficha, "Tu tratamiento" |
| `/#p=...` | Tarjeta del farmacéutico, directa, sin editor |

Si hay hash **y** el paciente tiene lista guardada, gana el hash (es lo que se
acaba de escanear). Si el hash coincide con la lista propia aparece el botón
"Editar"; si no, un enlace discreto "¿Eres el paciente? Crea tu propio pase".

### Formato del hash

```
#p=amlodipine:5mg:tab,metformin:850mg:tab
```

- Cada campo pasa por `encodeURIComponent` (p. ej. `insulin%20glargine`,
  `100IU%2Fml`); separadores `:` y `,` sin codificar.
- Solo viaja `inn` (inglés del catálogo) + `dose` + `form`. **Las marcas no van
  en el QR**: al abrir el hash se resuelve `inn` contra `drugs.json` para pintar
  `inn_es`, alertas y marcas del país seleccionado.
- Un `inn` que no esté en el catálogo se muestra tal cual, marcado como
  "No está en el catálogo del piloto".

### Persistencia

`localStorage["innpass.meds.v1"]` → `[{ inn, dose, form }]`. Solo en el móvil
del paciente. El móvil del farmacéutico no guarda nada al escanear.

### Selector de país

Solo en la vista del pase, por defecto `ES`. Muestra `brands[cc]` de cada
fármaco. No forma parte del QR.

### Wallet

"Añadir a Wallet" enlaza a <https://walletwallet.alen.ro> como fase 2. No hay
firma `.pkpass` ni JWT de Google en este piloto.

## Criterios de hecho

1. Escribe `norvasc`, elige **5 mg** + **comprimido**, pulsa **Mostrar pase**.
2. Verás **AMLODIPINO** en grande, debajo `amlodipine · 5 mg · tablet`, y un QR.
3. Abre el enlace del QR en otro móvil o en incógnito: misma tarjeta, sin buscador.
4. Recarga la página del paciente: "Tu tratamiento" sigue ahí.
5. Busca `metamizol` (o `Nolotil`): muestra la alerta *Not authorised in US/UK…*

## Actualizar la app desplegada

El service worker va a red primero (con 3 s de límite) y cae a la caché si no
hay conexión, así que en desarrollo basta con recargar para ver los cambios. Si
renombras o eliminas ficheros, sube `CACHE_VERSION` en `sw.js` para que los
clientes descarten la caché antigua.
