# Layering Tool

Ett lagerbaserat bildredigeringsverktyg som körs i webbläsaren. Det är byggt som en installerbar PWA för Android (Chrome) och fungerar även på PC (Chrome/Edge).

- **Fungerar offline.** En service worker sparar hela appen i cachen vid första besöket.
- **Bilder stannar lokalt.** Ingenting laddas upp, och det behövs inget konto eller någon server.
- **Inga beroenden och inget byggsteg.** Appen består av ren HTML, CSS och JavaScript (ES-moduler).

## Funktioner (V1)

| Område | Innehåll |
|---|---|
| Import | Flera bilder åt gången, med beskärning före import. Det nya lagret centreras i vyn, fyller ca 72 % av den och blir aktivt. |
| Lager | Välj aktivt lager, visa/dölj, flytta upp/ned, exportera lagret som PNG och radera. |
| Opacity | Reglage för aktivt lager, 0–100 %. |
| Move | Mobil: ett finger flyttar, två fingrar skalar och roterar. PC: dra för att flytta, scrollhjul skalar, Shift + scrollhjul eller handtaget roterar. ↔ spegelvänder. |
| Erase / Restore | Pensel med Size, Hardness och Strength. Indikatorn kan slås av och på. Offset finns bara på mobil och ställs in i Layers-panelen. |
| Magic | Påverkar bara sammanhängande pixlar inom penseln som har liknande färg (Tolerance). Pixlar med avvikande färg fungerar som barriär. |
| Zoom | Panorera och zooma vyn utan att ändra lagren. Knapparna Fit och 100 %. |
| Adjust | Brightness, Contrast, Saturation, Hue och Gamma per lager. Ändringarna är icke-destruktiva. Tryck på värdet för att nollställa det. |
| Save | Beskär och exportera kompositionen som PNG med transparens, utan rutmönster eller UI. |
| Undo / Redo | Gäller alla redigeringar. Ett penseldrag eller ett reglagedrag räknas som ett steg. På PC fungerar även Ctrl+Z / Ctrl+Y. |

Mobil- eller PC-läge väljs automatiskt utifrån pekdonet. Du kan tvinga fram ett läge med `?mode=mobile` eller `?mode=pc`.

## Köra lokalt

Appen behöver serveras över http(s), eftersom ES-moduler och service worker inte fungerar via `file://`:

```bash
python3 -m http.server 8000
```

Öppna sedan http://localhost:8000.

## Publicera (GitHub Pages)

Workflowet `.github/workflows/pages.yml` publicerar appen vid push till `main`. Det kan också köras manuellt.

1. Gå till repots **Settings → Pages** och välj **Source: GitHub Actions**.
2. Pusha till `main`. Appen hamnar på `https://<användare>.github.io/<repo>/`.
3. Öppna adressen i Chrome på Android och välj **Lägg till på startskärmen / Installera app**. Därefter fungerar appen offline.

## Uppdatera appen

När en fil ändras ska `VERSION` i `sw.js` höjas, så att installerade appar hämtar den nya versionen. Om du lägger till en ny fil måste den också läggas in i `ASSETS` i `sw.js`.

## Struktur

```
index.html            layout
css/app.css           stil (mörkt tema, mobil först)
js/main.js            UI, verktyg, gester, lageroperationer
js/view.js            arbetsyta, vy-transform (zoom/pan), rendering
js/layer.js           lagermodell, mask, färgjusteringar
js/brush.js           Erase/Restore + Magic (flood fill med tolerans)
js/crop.js            beskärningsväljare (import + export)
js/export.js          PNG-export av komposition och enskilt lager
js/history.js         Undo/Redo
sw.js                 service worker (offline)
tools/render-icons.js genererar PNG-ikoner från SVG (Playwright)
```

## Begränsningar

- Stora bilder skalas ned till en arbetskopia: max ca 4 MP på mobil och 12 MP på PC. Appen visar ett meddelande när det sker.
- Exporten använder den högsta upplösningen bland de synliga lagren, med ett tak på 8192 px per sida.
- Projektet sparas inte mellan sessioner. Det ingår inte i V1.
