# Żużel 3D

Gra żużlowa w przeglądarce. Three.js r128, bez narzędzi budujących.

## Co jest w środku

    index.html          gra — tryb biegu, treningu i meczu ligowego
    podglad.html        podgląd modelu zawodnika z proceduralnym kevlarem
    js/gra.js           cały kod gry
    js/kevlar.js        malowanie kombinezonu na atlasie modelu
    modele/             siatka zawodnika (glTF) i tekstury

## Uruchomienie w VS Code (zalecane)

1. **Otwórz w VS Code ten katalog** — nie katalog nadrzędny. Ścieżki są
   względne, więc korzeń serwera musi wypadać tam, gdzie leży `index.html`.
   W VS Code: File → Open Folder → wskaż `zuzel-3d`.
2. Zainstaluj rozszerzenie **Live Server** (Ritwick Dey). Po otwarciu katalogu
   VS Code sam je zaproponuje — jest wpisane w `.vscode/extensions.json`.
3. Kliknij prawym na `podglad.html` → **Open with Live Server**.
   Albo przycisk **Go Live** na dolnym pasku.

Otworzy się `http://127.0.0.1:5500/podglad.html`. Gra jest pod `/index.html`.

W `.vscode/settings.json` jest już ustawiony port 5500 i wyłączone
przeładowywanie przy zmianie plików modelu — bez tego Live Server
przeładowywałby stronę przy każdym dotknięciu tekstury.

## Uruchomienie bez VS Code

`index.html` otworzysz zwykłym dwuklikiem — gra nie wczytuje plików z dysku.

`podglad.html` **wymaga serwera**, bo przeglądarka blokuje wczytywanie modelu
z adresu `file://`. Wystarczy jedna komenda w katalogu projektu:

    python3 -m http.server 8000

potem `http://localhost:8000/podglad.html`. Alternatywnie `npx serve`.

## Publikacja na GitHub Pages

Działa bez żadnych zmian w kodzie — to zwykłe pliki statyczne, a Pages
serwuje je po HTTPS, więc znika problem z `file://`.

1. Utwórz repozytorium i wrzuć całą zawartość tego katalogu do korzenia.
2. Settings → Pages → Source: **Deploy from a branch**, gałąź `main`, katalog `/ (root)`.
3. Po chwili strona będzie pod `https://<login>.github.io/<repozytorium>/`.

### Na co uważać

- **Wielkość liter w nazwach plików ma znaczenie.** Serwer Pages działa na
  Linuksie, więc `Modele/Zawodnik.gltf` nie zadziała, choć lokalnie na
  Windowsie czy macOS działało. Wszystkie ścieżki w projekcie są małymi literami.
- **Ścieżki muszą być względne** — `modele/zawodnik.gltf`, nigdy `/modele/...`.
  Ukośnik na początku wskazuje korzeń domeny, a projekt leży w podkatalogu.
- Repozytorium musi być publiczne (albo konto płatne).
- Limity Pages: 1 GB na repozytorium, 100 GB transferu miesięcznie —
  ten projekt waży 5 MB, więc nie ma tematu.
- Git LFS nie jest potrzebny przy tych rozmiarach.
- Po wypchnięciu zmian odświeżenie strony potrafi potrwać minutę.

## Zawodnik w grze

Gra używa modelu z `modele/` zamiast zawodnika składanego z walców i kul.
Model wczytuje się w tle przy starcie; **dopóki nie jest gotowy — albo gdyby
się nie wczytał — gra działa dalej na zawodniku z brył**, więc nic nie przestaje
działać. Klawisz **M** przełącza między jednym a drugim (zmiana od następnego
biegu), co przydaje się do porównania i na słabszym sprzęcie.

Pozowanie korzysta z tych samych punktów, które gra liczyła dotąd: biodra na
siodle, kierunek tułowia, manetki obracające się razem z kierownicą i podnóżki.
Reakcja na ślizg, przechył, gaz i upadek jest więc identyczna — zmienia się
wyłącznie bryła.

**Uwaga: `index.html` nie otworzy się już dwuklikiem**, bo wczytuje model
z dysku. Potrzebny jest serwer — Live Server w VS Code albo `python3 -m http.server`.

## Model zawodnika

Postać z Mixamo, 49 867 trójkątów, szkielet 66 kości w standardzie
`mixamorig`. Kombinezon nie jest malowany ręcznie — `js/kevlar.js` liczy
z wag skórowania, która część atlasu odpowiada której partii ciała, i
przemalowuje ją w barwy klubu, zachowując jasność oryginału jako fakturę.

Tekstury źródłowe (4096 px, 42 MB) zostały zredukowane do 1024 px i 4,5 MB
bez zauważalnej straty — z rozproszenia potrzebna jest tylko jasność.

## Gdy podgląd nie wczytuje modelu

Panel po lewej wypisuje kolejne etapy. Po ich odczytaniu wiadomo, gdzie jest problem:

    ✓ model: 49 867 trójkątów, 66 kości      siatka wczytana
    ✓ tekstury wczytane                       faktura i mapa normalnych
    ✓ mapa partii ciała: 68,2% atlasu         podział wyliczony z wag skórowania
    ✓ kevlar przemalowany w 180 ms            tekstura gotowa

Jeśli pierwszy wiersz ma krzyżyk i mówi o błędzie sieci albo CORS —
otwierasz plik prosto z dysku. Uruchom serwer:

    python3 -m http.server 8000

Jeśli pokrycie mapy jest bliskie zeru, daj znać: to znaczy, że rasteryzacja
atlasu nie zadziałała na Twojej przeglądarce i trzeba ją zrobić inaczej.
