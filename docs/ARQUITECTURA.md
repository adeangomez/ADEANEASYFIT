# Arquitectura de ADEANEASYFIT

```
index.html     App del cliente (PWA, todo el código en un solo archivo)
admin.html     Panel del administrador / entrenador
assets/        Iconos, banner y fotos de la biblioteca de ejercicios (assets/ejercicios)
worker.js      API en Cloudflare Workers (cuentas, datos, IA, emails)
wrangler.toml  Configuración del Worker (base de datos KV, IA y tarea diaria)
scripts/       Herramientas para trabajar en local
tests/         Pruebas automáticas del worker
docs/          Documentación
```

## Cómo encaja todo

| Pieza | Dónde vive | Para qué |
| --- | --- | --- |
| App y panel | GitHub Pages (`https://adeangomez.github.io/ADEANEASYFIT/`) | Páginas estáticas; la ruta distingue mayúsculas |
| API | Cloudflare Worker `adeanfit-api` | Sesiones, datos de cada usuario, rutinas con IA, informes por email |
| Datos | Cloudflare KV (`ADEANFIT_KV`) | Usuarios, rutinas, sesiones y sugerencias |
| IA | Cloudflare Workers AI | Generar rutinas y analizar progreso |
| Emails | Resend | Informes de progreso (periódicos y bajo demanda) |
| Gráficas de los emails | quickchart.io | Imágenes de las gráficas |

## Datos de cada usuario

`data:<usuario>` guarda `{ profile, plans, activePlanId, state, _rev }`:

- `profile`: peso, altura, experiencia, historial de peso, foto, preferencia de email y `consents` (aceptación de los textos legales con su versión).
- `plans`: rutinas con días y ejercicios.
- `state.sessions`: sesiones guardadas (`exercises → sets → kg y reps`).
- `_rev`: número de revisión para detectar cambios hechos desde otro dispositivo.

## Los dos puntos de entrada de la API que más se usan

- `GET/PUT /data`: carga y guarda los datos del usuario con sesión iniciada.
- `POST /send-report-email` y `POST /admin/send-report-email`: informe de un día de rutina o de un ejercicio.

## Textos legales

Están dentro de `index.html` (`LEGAL_DOCS`). Al cambiar su contenido se sube `LEGAL_VERSION` y todos los usuarios vuelven a aceptarlos antes de entrar.
